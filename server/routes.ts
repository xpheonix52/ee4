import { Router, type Request, type Response, type NextFunction } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import { db, id, now, token, sha256, hashPassword, verifyPassword, getSetting, setSetting } from './db.js'
import { bus, type AppEvent } from './bus.js'
import * as core from './core.js'
import * as kb from './knowledge.js'
import { SandboxTransport } from './wa.js'
import { agentReply, generate, aiConfigured, runModel } from './ai.js'
import { automationView, buildContext, executeAutomation, getAutomation, listAutomations, saveAutomation, TRIGGERS } from './automations.js'
import { forgetServer, listServerTools } from './mcpClient.js'

type Actor = { type: 'user' | 'api'; id: string; name: string; role: string }
declare module 'express-serve-static-core' { interface Request { actor?: Actor } }

export class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
const bad = (msg: string): never => { throw new HttpError(400, msg) }
const need = <T>(v: T | null | undefined, what = 'Not found'): T => { if (v == null) throw new HttpError(404, what); return v }
const str = (v: unknown, name: string) => (typeof v === 'string' && v.trim() ? v.trim() : bad(`${name} is required`))
const publicUser = (u: any) => u && { id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at }
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })

export function resolveActor(req: Request, allowQueryKey = false): Actor | null {
  const header = req.headers.authorization || ''
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : allowQueryKey && typeof req.query.key === 'string' ? req.query.key : ''
  if (key) {
    const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(key)) as any
    if (!row) return null
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id)
    return { type: 'api', id: row.id, name: row.name, role: 'admin' }
  }
  const sess = req.cookies?.sb_session
  if (!sess) return null
  const u = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?').get(sess, now()) as any
  return u ? { type: 'user', id: u.id, name: u.name, role: u.role } : null
}
export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
  const actor = resolveActor(req)
  if (!actor) throw new HttpError(401, 'Not signed in. Send a session cookie or "Authorization: Bearer <api key>".')
  req.actor = actor
  next()
}
const admin = (req: Request, _res: Response, next: NextFunction) => {
  if (req.actor?.role !== 'admin') throw new HttpError(403, 'Only admins can do this')
  next()
}
const sentBy = (req: Request) => (req.actor!.type === 'user' ? `user:${req.actor!.id}` : 'api')

function startSession(res: Response, userId: string) {
  const t = token(32)
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)').run(t, userId, now() + 30 * 86_400_000)
  res.cookie('sb_session', t, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86_400_000, secure: process.env.COOKIE_SECURE === 'true' })
}

export const api = Router()

// ---------- setup & auth (public) ----------
api.get('/setup/status', (_req, res) => {
  res.json({ needs_setup: !(db.prepare('SELECT 1 FROM users LIMIT 1').get()), workspace: getSetting('workspace').name })
})
api.post('/setup', (req, res) => {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409, 'Setup is already complete. Please sign in.')
  const name = str(req.body.name, 'Name'), email = str(req.body.email, 'Email').toLowerCase(), password = str(req.body.password, 'Password')
  if (password.length < 8) bad('Password must be at least 8 characters')
  const userId = id('usr')
  db.prepare('INSERT INTO users(id, email, name, password_hash, role, created_at) VALUES(?,?,?,?,?,?)').run(userId, email, name, hashPassword(password), 'admin', now())
  if (req.body.workspace) setSetting('workspace', { name: String(req.body.workspace), timezoneOffsetMinutes: Number(req.body.timezoneOffsetMinutes) || 0 })
  startSession(res, userId)
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) })
})
const failures = new Map<string, { n: number; until: number }>()
api.post('/auth/login', (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim()
  const who = `${req.ip}|${email}`
  const f = failures.get(who)
  if (f && f.n >= 10 && f.until > now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.')
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
    failures.set(who, { n: (f && f.until > now() ? f.n : 0) + 1, until: now() + 15 * 60_000 })
    throw new HttpError(401, 'Wrong email or password')
  }
  failures.delete(who)
  if (failures.size > 5000) failures.clear()
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now())
  startSession(res, u.id)
  res.json({ user: publicUser(u) })
})
api.post('/auth/logout', (req, res) => {
  if (req.cookies?.sb_session) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sb_session)
  res.clearCookie('sb_session')
  res.json({ ok: true })
})

/** Inbound trigger for automations: POST any JSON here and it becomes {{webhook.*}}. */
api.post('/hooks/:id/:token', async (req, res) => {
  const auto = getAutomation(String(req.params.id))
  if (!auto || auto.hook_token !== req.params.token) throw new HttpError(404, 'Unknown hook')
  if (!auto.enabled || auto.trigger.type !== 'webhook') throw new HttpError(409, 'This automation is off or does not use the webhook trigger')
  const chat = req.body?.chat_id ? core.getChat(String(req.body.chat_id)) : null
  const run = await executeAutomation(auto, buildContext({ webhook: req.body, chat }), 'webhook')
  res.json({ status: run.status, steps: run.steps })
})

api.use(requireAuth)

api.get('/me', (req, res) => {
  const user = req.actor!.type === 'user' ? publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.actor!.id)) : { id: req.actor!.id, name: req.actor!.name, role: 'admin', api_key: true }
  res.json({ user, workspace: getSetting('workspace'), ai_configured: aiConfigured() })
})

// ---------- live events ----------
api.get('/events', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write(': connected\n\n')
  const on = (e: AppEvent) => res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
  const beat = setInterval(() => res.write(': ping\n\n'), 25_000)
  bus.on('event', on)
  req.on('close', () => { clearInterval(beat); bus.off('event', on) })
})

// ---------- team ----------
api.get('/users', (_req, res) => res.json((db.prepare('SELECT * FROM users ORDER BY created_at').all() as any[]).map(publicUser)))
api.post('/users', admin, (req, res) => {
  const email = str(req.body.email, 'Email').toLowerCase(), password = str(req.body.password, 'Password')
  if (password.length < 8) bad('Password must be at least 8 characters')
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) bad('Someone with that email already exists')
  const userId = id('usr')
  db.prepare('INSERT INTO users(id, email, name, password_hash, role, created_at) VALUES(?,?,?,?,?,?)')
    .run(userId, email, str(req.body.name, 'Name'), hashPassword(password), req.body.role === 'admin' ? 'admin' : 'agent', now())
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)))
})
api.patch('/users/:id', admin, (req, res) => {
  const u = need(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id) as any)
  const role = req.body.role === 'admin' || req.body.role === 'agent' ? req.body.role : u.role
  if (u.role === 'admin' && role !== 'admin' && (db.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin'`).get() as any).n <= 1) bad('There must be at least one admin')
  if (req.body.password && String(req.body.password).length < 8) bad('Password must be at least 8 characters')
  db.prepare('UPDATE users SET name = ?, role = ?, password_hash = ? WHERE id = ?')
    .run(req.body.name || u.name, role, req.body.password ? hashPassword(String(req.body.password)) : u.password_hash, u.id)
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)))
})
api.delete('/users/:id', admin, (req, res) => {
  if (req.params.id === req.actor!.id) bad('You cannot remove yourself')
  db.prepare('UPDATE chats SET assignee_id = NULL WHERE assignee_id = ?').run(req.params.id)
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ---------- numbers ----------
api.get('/numbers', (_req, res) => res.json(core.listNumbers()))
api.post('/numbers', admin, async (req, res) => {
  const kind = req.body.kind === 'sandbox' ? 'sandbox' : 'whatsapp'
  const n = { id: id('num'), name: str(req.body.name, 'Name'), kind }
  db.prepare('INSERT INTO numbers(id, name, kind, status, created_at) VALUES(?,?,?,?,?)').run(n.id, n.name, kind, 'connecting', now())
  await core.startNumber(n)
  res.json(core.numberView(core.getNumber(n.id)))
})
api.patch('/numbers/:id', admin, (req, res) => {
  const n = need(core.getNumber(String(req.params.id)))
  db.prepare('UPDATE numbers SET name = ?, ai_enabled = ? WHERE id = ?').run(req.body.name || n.name, req.body.ai_enabled == null ? n.ai_enabled : req.body.ai_enabled ? 1 : 0, n.id)
  res.json(core.numberView(core.getNumber(n.id)))
})
api.post('/numbers/:id/connect', admin, async (req, res) => {
  const n = need(core.getNumber(String(req.params.id)))
  await core.startNumber(n)
  res.json(core.numberView(core.getNumber(n.id)))
})
api.post('/numbers/:id/pairing-code', admin, async (req, res) => {
  const t = need(core.getTransport(String(req.params.id)), 'Number is not started')
  res.json({ code: await t.pairingCode(str(req.body.phone, 'Phone number')) })
})
api.post('/numbers/:id/logout', admin, async (req, res) => {
  const n = need(core.getNumber(String(req.params.id)))
  await core.getTransport(n.id)?.logout()
  res.json(core.numberView(core.getNumber(n.id)))
})
api.delete('/numbers/:id', admin, async (req, res) => { await core.removeNumber(String(req.params.id)); res.json({ ok: true }) })
api.post('/numbers/:id/simulate', (req, res) => {
  const t = core.getTransport(String(req.params.id))
  if (!(t instanceof SandboxTransport)) bad('Only sandbox numbers can simulate incoming messages')
  ;(t as SandboxTransport).simulate({ from: str(req.body.from, 'from'), name: req.body.name, text: str(req.body.text, 'text'), group: req.body.group, timestamp: Number(req.body.timestamp) || undefined })
  res.json({ ok: true })
})

// ---------- chats & messages ----------
api.get('/chats', (req, res) => {
  const q = req.query as Record<string, string>
  res.json(core.listChats({ q: q.q, number_id: q.number_id, label: q.label, assignee: q.assignee === 'me' ? req.actor!.id : q.assignee, status: q.status, type: q.type, unread: q.unread === 'true', limit: Number(q.limit) || undefined }))
})
api.get('/chats/:id', (req, res) => res.json(need(core.getChat(req.params.id), 'Chat not found')))
api.patch('/chats/:id', (req, res) => {
  need(core.getChat(req.params.id), 'Chat not found')
  const p = req.body || {}
  if (p.status && !['open', 'closed'].includes(p.status)) bad('status must be open or closed')
  if (p.ai_mode && !['default', 'on', 'off'].includes(p.ai_mode)) bad('ai_mode must be default, on or off')
  res.json(core.updateChat(req.params.id, p))
})
api.post('/chats/:id/read', (req, res) => res.json(need(core.updateChat(req.params.id, { unread: 0 }), 'Chat not found')))
api.post('/chats/:id/labels', (req, res) => { need(core.getChat(req.params.id), 'Chat not found'); res.json(core.addLabel(req.params.id, str(req.body.label, 'label'))) })
api.delete('/chats/:id/labels/:label', (req, res) => res.json(need(core.removeLabel(req.params.id, req.params.label), 'Chat not found')))
api.get('/chats/:id/messages', (req, res) => res.json(core.listMessages(req.params.id, { before: Number(req.query.before) || undefined, limit: Number(req.query.limit) || undefined })))
api.post('/chats/:id/messages', upload.single('file'), (req, res) => {
  need(core.getChat(String(req.params.id)), 'Chat not found')
  const media = req.file ? { buffer: req.file.buffer, mime: req.file.mimetype, name: req.file.originalname } : undefined
  try { res.json(core.sendMessage({ chatId: String(req.params.id), text: req.body?.text, media, sentBy: sentBy(req), senderName: req.actor!.name }).message) }
  catch (e: any) { bad(e.message) }
})
api.post('/chats/:id/notes', (req, res) => { need(core.getChat(req.params.id), 'Chat not found'); res.json(core.addNote(req.params.id, str(req.body.text, 'text'), req.actor!.name)) })
api.post('/chats/:id/ai/draft', async (req, res) => res.json({ text: (await agentReply(need(core.getChat(req.params.id), 'Chat not found').id, { dryRun: true })).text }))
api.post('/chats/:id/ai/summary', async (req, res) => {
  const chat = need(core.getChat(req.params.id), 'Chat not found')
  res.json({ text: await generate('Summarize this conversation in 3 short bullet points, then list any open action items.', { chatId: chat.id }) })
})
/** Send to a phone number directly, creating the chat if needed. */
api.post('/messages', async (req, res) => {
  const chat = req.body.chat_id ? need(core.getChat(String(req.body.chat_id)), 'Chat not found')
    : await core.chatForPhone(str(req.body.number_id, 'number_id (or chat_id)'), str(req.body.to, 'to'), req.body.name).catch((e) => bad(e.message))
  res.json(core.sendMessage({ chatId: chat.id, text: str(req.body.text, 'text'), sentBy: sentBy(req), senderName: req.actor!.name }).message)
})
api.get('/media/:id', (req, res) => {
  const m = need(core.getMessage(req.params.id))
  if (!m.media_path || !fs.existsSync(m.media_path)) throw new HttpError(404, 'No media')
  const mime = String(m.media_mime || '').split(';')[0].trim().toLowerCase()
  const inline = /^(image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|3gpp|quicktime)|audio\/[\w.+-]+|application\/pdf)$/.test(mime)
  res.setHeader('content-type', inline ? mime : 'application/octet-stream')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('content-security-policy', "default-src 'none'; sandbox")
  res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(m.media_name || 'file')}"`)
  fs.createReadStream(m.media_path).pipe(res)
})

// ---------- labels & quick replies ----------
api.get('/labels', (_req, res) => res.json(db.prepare('SELECT * FROM labels ORDER BY name').all()))
api.post('/labels', (req, res) => {
  const name = str(req.body.name, 'Name')
  if (db.prepare('SELECT 1 FROM labels WHERE name = ? COLLATE NOCASE').get(name)) bad('That label already exists')
  const l = { id: id('lbl'), name, color: req.body.color || '#2563eb' }
  db.prepare('INSERT INTO labels(id, name, color) VALUES(?,?,?)').run(l.id, l.name, l.color)
  res.json(l)
})
api.delete('/labels/:id', (req, res) => { db.prepare('DELETE FROM labels WHERE id = ?').run(req.params.id); res.json({ ok: true }) })
api.get('/quick-replies', (_req, res) => res.json(db.prepare('SELECT * FROM quick_replies ORDER BY shortcut').all()))
api.post('/quick-replies', (req, res) => {
  const q = { id: id('qr'), shortcut: str(req.body.shortcut, 'Shortcut').replace(/^\//, '').toLowerCase(), text: str(req.body.text, 'Text') }
  if (db.prepare('SELECT 1 FROM quick_replies WHERE shortcut = ?').get(q.shortcut)) bad('That shortcut already exists')
  db.prepare('INSERT INTO quick_replies(id, shortcut, text) VALUES(?,?,?)').run(q.id, q.shortcut, q.text)
  res.json(q)
})
api.delete('/quick-replies/:id', (req, res) => { db.prepare('DELETE FROM quick_replies WHERE id = ?').run(req.params.id); res.json({ ok: true }) })

// ---------- tickets ----------
api.get('/tickets', (req, res) => {
  const where: string[] = [], args: any[] = []
  for (const k of ['status', 'chat_id', 'assignee_id']) if (req.query[k]) { where.push(`t.${k} = ?`); args.push(req.query[k]) }
  res.json(db.prepare(`SELECT t.*, c.name AS chat_name FROM tickets t LEFT JOIN chats c ON c.id = t.chat_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC LIMIT 500`).all(...args))
})
api.post('/tickets', (req, res) => res.json(core.createTicket({ chatId: req.body.chat_id, messageId: req.body.message_id, title: str(req.body.title, 'Title'), description: req.body.description, priority: req.body.priority, assigneeId: req.body.assignee_id, createdBy: sentBy(req) })))
api.patch('/tickets/:id', (req, res) => {
  need(core.getTicket(req.params.id), 'Ticket not found')
  if (req.body.status && !['open', 'in_progress', 'resolved'].includes(req.body.status)) bad('status must be open, in_progress or resolved')
  res.json(core.updateTicket(req.params.id, req.body))
})
api.delete('/tickets/:id', (req, res) => { db.prepare('DELETE FROM tickets WHERE id = ?').run(req.params.id); res.json({ ok: true }) })

// ---------- automations ----------
function validAutomation(b: any) {
  if (b.trigger && !(TRIGGERS as readonly string[]).includes(b.trigger.type)) bad(`trigger.type must be one of ${TRIGGERS.join(', ')}`)
  if (b.trigger?.type === 'schedule' && !/^\d\d:\d\d$/.test(b.trigger.time || '')) bad('Scheduled automations need a time (HH:MM)')
  if (b.actions && (!Array.isArray(b.actions) || !b.actions.length)) bad('Add at least one action')
  if (b.conditions && !Array.isArray(b.conditions)) bad('conditions must be a list')
  for (const c of b.conditions || []) if (!c || typeof c.field !== 'string' || typeof c.op !== 'string') bad('Each condition needs a field and an operator')
  for (const a of b.actions || []) if (!a || typeof a.type !== 'string') bad('Each action needs a type')
  return b
}
api.get('/automations', (_req, res) => res.json(listAutomations()))
api.post('/automations', (req, res) => { str(req.body.name, 'Name'); if (!req.body.actions) bad('Add at least one action'); res.json(saveAutomation(validAutomation(req.body))) })
api.put('/automations/:id', (req, res) => { const cur = need(getAutomation(req.params.id)); res.json(saveAutomation({ ...validAutomation(req.body), name: req.body.name || cur.name }, cur.id)) })
api.delete('/automations/:id', (req, res) => { db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id); res.json({ ok: true }) })
api.get('/automations/:id/runs', (req, res) => res.json((db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id) as any[]).map((r) => ({ ...r, log: JSON.parse(r.log) }))))
api.post('/automations/:id/run', async (req, res) => {
  const auto = need(getAutomation(req.params.id))
  const chat = req.body?.chat_id ? core.getChat(String(req.body.chat_id)) : null
  res.json(await executeAutomation(auto, buildContext({ chat, message: req.body?.text ? { text: req.body.text, sender_name: chat?.name } : undefined }), 'manual run'))
})

// ---------- knowledge hub ----------
api.get('/knowledge', (_req, res) => res.json(kb.listDocs()))
api.get('/knowledge/search', (req, res) => res.json(kb.searchKnowledge(String(req.query.q || ''), Number(req.query.limit) || 5)))
api.get('/knowledge/:id', (req, res) => res.json(need(kb.getDoc(req.params.id))))
api.post('/knowledge', async (req, res) => {
  if (req.body.url) return res.json(await kb.importUrl(str(req.body.url, 'URL')).catch((e) => bad(e.message)))
  res.json(kb.addDoc({ title: str(req.body.title, 'Title'), content: str(req.body.content, 'Content') }))
})
api.post('/knowledge/upload', upload.single('file'), (req, res) => {
  const f = req.file ?? bad('Choose a file to upload')
  if (!/\.(txt|md|markdown|csv|json|html?)$/i.test(f.originalname)) bad('Supported files: .txt, .md, .csv, .json, .html')
  const raw = f.buffer.toString('utf8')
  res.json(kb.addDoc({ title: f.originalname.replace(/\.[^.]+$/, ''), content: /\.html?$/i.test(f.originalname) ? kb.htmlToText(raw) : raw, source: 'file' }))
})
api.put('/knowledge/:id', (req, res) => res.json(need(kb.updateDoc(req.params.id, { title: req.body.title, content: req.body.content }))))
api.delete('/knowledge/:id', (req, res) => { kb.deleteDoc(req.params.id); res.json({ ok: true }) })

// ---------- AI ----------
const maskAi = () => { const a = getSetting('ai'); return { ...a, apiKey: a.apiKey ? `${a.apiKey.slice(0, 6)}…${a.apiKey.slice(-4)}` : '', has_key: !!a.apiKey } }
api.get('/ai/settings', (_req, res) => res.json(maskAi()))
api.put('/ai/settings', admin, (req, res) => {
  const { apiKey, has_key, ...rest } = req.body || {}
  if (rest.provider && !['anthropic', 'openai'].includes(rest.provider)) bad('provider must be anthropic or openai')
  setSetting('ai', { ...rest, ...(typeof apiKey === 'string' && !apiKey.includes('…') ? { apiKey: apiKey.trim() } : {}) })
  res.json(maskAi())
})
/** Playground: ask the agent something without touching any real chat. */
api.post('/ai/test', async (req, res) => {
  const hits = kb.searchKnowledge(str(req.body.message, 'message'))
  const cfg = getSetting('ai')
  const system = `${cfg.instructions}\nYour name is ${cfg.agentName}. You work for ${getSetting('workspace').name}. Write short plain-text WhatsApp replies.\n\nRelevant knowledge:\n${hits.map((h) => `## ${h.title}\n${h.body}`).join('\n\n') || '(nothing found)'}`
  const r = await runModel(system, [{ role: 'user', text: req.body.message }]).catch((e) => bad(e.message))
  res.json({ text: r.text, sources: hits.map((h) => h.title) })
})

// ---------- external MCP servers (tools for the AI agent) ----------
const mcpView = (s: any) => ({ ...s, enabled: !!s.enabled, headers: undefined, has_headers: s.headers !== '{}' })
api.get('/mcp-servers', (_req, res) => res.json((db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as any[]).map(mcpView)))
api.post('/mcp-servers', admin, (req, res) => {
  const url = str(req.body.url, 'URL')
  try { new URL(url) } catch { bad('Enter a full URL, for example https://example.com/mcp') }
  let headers = '{}'
  if (req.body.headers) { try { headers = JSON.stringify(typeof req.body.headers === 'string' ? JSON.parse(req.body.headers) : req.body.headers) } catch { bad('Headers must be JSON, for example {"Authorization": "Bearer ..."}') } }
  const s = { id: id('mcp'), name: str(req.body.name, 'Name'), url, headers }
  db.prepare('INSERT INTO mcp_servers(id, name, url, headers, created_at) VALUES(?,?,?,?,?)').run(s.id, s.name, s.url, s.headers, now())
  res.json(mcpView(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(s.id)))
})
api.patch('/mcp-servers/:id', admin, (req, res) => {
  db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, req.params.id)
  res.json(mcpView(need(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id))))
})
api.delete('/mcp-servers/:id', admin, (req, res) => { forgetServer(String(req.params.id)); db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(req.params.id); res.json({ ok: true }) })
api.post('/mcp-servers/:id/test', async (req, res) => {
  const s = need(db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(req.params.id) as any)
  try { res.json({ ok: true, tools: (await listServerTools(s, true)).map((t: any) => ({ name: t.name, description: t.description })) }) }
  catch (e: any) { res.json({ ok: false, error: String(e?.message || e) }) }
})

// ---------- developers: API keys & webhooks ----------
api.get('/api-keys', admin, (_req, res) => res.json(db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all()))
api.post('/api-keys', admin, (req, res) => {
  const key = `sb_${token(30)}`
  const row = { id: id('key'), name: str(req.body.name, 'Name'), prefix: key.slice(0, 9) }
  db.prepare('INSERT INTO api_keys(id, name, key_hash, prefix, created_at) VALUES(?,?,?,?,?)').run(row.id, row.name, sha256(key), row.prefix, now())
  res.json({ ...row, key })
})
api.delete('/api-keys/:id', admin, (req, res) => { db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id); res.json({ ok: true }) })
const hookView = (w: any) => ({ ...w, enabled: !!w.enabled, events: JSON.parse(w.events) })
api.get('/webhooks', admin, (_req, res) => res.json((db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as any[]).map(hookView)))
api.post('/webhooks', admin, (req, res) => {
  const url = str(req.body.url, 'URL')
  try { new URL(url) } catch { bad('Enter a full URL, for example https://example.com/hook') }
  const w = { id: id('whk'), url, events: JSON.stringify(Array.isArray(req.body.events) && req.body.events.length ? req.body.events : ['*']), secret: `whsec_${token(24)}` }
  db.prepare('INSERT INTO webhooks(id, url, events, secret, created_at) VALUES(?,?,?,?,?)').run(w.id, w.url, w.events, w.secret, now())
  res.json(hookView(db.prepare('SELECT * FROM webhooks WHERE id = ?').get(w.id)))
})
api.delete('/webhooks/:id', admin, (req, res) => { db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id); res.json({ ok: true }) })
api.get('/webhooks/:id/deliveries', admin, (req, res) => res.json(db.prepare('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.id)))

// ---------- scheduled messages & broadcasts ----------
const schedView = (s: any) => ({ ...s, chat_ids: JSON.parse(s.chat_ids) })
api.get('/scheduled', (_req, res) => res.json((db.prepare('SELECT * FROM scheduled ORDER BY send_at DESC LIMIT 200').all() as any[]).map(schedView)))
api.post('/scheduled', (req, res) => {
  const chatIds: string[] = Array.isArray(req.body.chat_ids) ? req.body.chat_ids.filter((c: any) => core.getChat(String(c))) : []
  if (!chatIds.length) bad('Pick at least one chat')
  const sendAt = req.body.send_at ? Number(new Date(req.body.send_at)) : now()
  if (!Number.isFinite(sendAt)) bad('send_at is not a valid date')
  const s = { id: id('sch'), repeat: ['daily', 'weekly'].includes(req.body.repeat) ? req.body.repeat : 'none' }
  db.prepare('INSERT INTO scheduled(id, name, chat_ids, text, send_at, repeat, created_by, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(s.id, req.body.name || null, JSON.stringify(chatIds), str(req.body.text, 'Message'), sendAt, s.repeat, req.actor!.name, now())
  res.json(schedView(db.prepare('SELECT * FROM scheduled WHERE id = ?').get(s.id)))
})
api.delete('/scheduled/:id', (req, res) => { db.prepare('DELETE FROM scheduled WHERE id = ?').run(req.params.id); res.json({ ok: true }) })

// ---------- settings & analytics ----------
api.get('/settings', (_req, res) => res.json({ workspace: getSetting('workspace'), businessHours: getSetting('businessHours'), sending: getSetting('sending') }))
api.put('/settings', admin, (req, res) => {
  for (const k of ['workspace', 'businessHours', 'sending'] as const) if (req.body[k] && typeof req.body[k] === 'object') setSetting(k, req.body[k])
  res.json({ workspace: getSetting('workspace'), businessHours: getSetting('businessHours'), sending: getSetting('sending') })
})
api.get('/analytics', (_req, res) => {
  const since = now() - 7 * 86_400_000
  const one = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).n as number
  const msgs = db.prepare(`SELECT chat_id, direction, created_at, sent_by FROM messages WHERE created_at >= ? AND direction != 'note' ORDER BY chat_id, created_at`).all(since) as any[]
  const days: Record<string, { in: number; out: number }> = {}
  for (let i = 6; i >= 0; i--) days[new Date(now() - i * 86_400_000).toISOString().slice(0, 10)] = { in: 0, out: 0 }
  const waits: number[] = []
  const byAgent: Record<string, number> = {}
  let waitingSince: number | null = null, lastChat = ''
  for (const m of msgs) {
    if (m.chat_id !== lastChat) { waitingSince = null; lastChat = m.chat_id }
    const day = days[new Date(m.created_at).toISOString().slice(0, 10)]
    if (day) day[m.direction === 'in' ? 'in' : 'out']++
    if (m.direction === 'in') waitingSince ??= m.created_at
    else {
      if (waitingSince != null) { waits.push(m.created_at - waitingSince); waitingSince = null }
      const who = m.sent_by?.startsWith('user:') ? m.sent_by.slice(5) : m.sent_by?.split(':')[0] || 'other'
      byAgent[who] = (byAgent[who] || 0) + 1
    }
  }
  const names = Object.fromEntries((db.prepare('SELECT id, name FROM users').all() as any[]).map((u) => [u.id, u.name]))
  waits.sort((a, b) => a - b)
  res.json({
    open_chats: one(`SELECT COUNT(*) n FROM chats WHERE status = 'open'`), unread_chats: one('SELECT COUNT(*) n FROM chats WHERE unread > 0'),
    unassigned_chats: one(`SELECT COUNT(*) n FROM chats WHERE status = 'open' AND assignee_id IS NULL`),
    open_tickets: one(`SELECT COUNT(*) n FROM tickets WHERE status != 'resolved'`), automations_run: one('SELECT COUNT(*) n FROM automation_runs WHERE created_at >= ?', since),
    messages_in: msgs.filter((m) => m.direction === 'in').length, messages_out: msgs.filter((m) => m.direction !== 'in').length,
    median_response_seconds: waits.length ? Math.round(waits[Math.floor(waits.length / 2)] / 1000) : null,
    by_day: Object.entries(days).map(([date, v]) => ({ date, ...v })),
    by_sender: Object.entries(byAgent).map(([k, count]) => ({ name: names[k] || ({ ai: 'AI agent', automation: 'Automations', api: 'API', mcp: 'MCP', phone: 'Phone', broadcast: 'Broadcasts', scheduled: 'Scheduled' } as any)[k] || k, count })).sort((a, b) => b.count - a.count),
  })
})
