import fs from 'node:fs'
import path from 'node:path'
import { db, id, now, DATA_DIR, getSetting } from './db.js'
import { emit } from './bus.js'
import { BaileysTransport, SandboxTransport, type Incoming, type Transport } from './wa.js'

// ---------- numbers ----------
const transports = new Map<string, Transport>()
const qrCodes = new Map<string, string>()

export function numberView(n: any) {
  return { ...n, ai_enabled: !!n.ai_enabled, qr: qrCodes.get(n.id) || null }
}
export const getNumber = (numberId: string) => db.prepare('SELECT * FROM numbers WHERE id = ?').get(numberId) as any
export const listNumbers = () => (db.prepare('SELECT * FROM numbers ORDER BY created_at').all() as any[]).map(numberView)
export const getTransport = (numberId: string) => transports.get(numberId)

export async function startNumber(n: { id: string; kind: string }) {
  await transports.get(n.id)?.stop()
  const handlers = {
    onStatus: (status: string, extra?: { qr?: string | null; phone?: string }) => {
      if (extra?.qr) qrCodes.set(n.id, extra.qr)
      if (extra?.qr === null || status === 'connected' || status === 'disconnected') qrCodes.delete(n.id)
      db.prepare('UPDATE numbers SET status = ?, phone = COALESCE(?, phone) WHERE id = ?').run(status, extra?.phone ?? null, n.id)
      const row = getNumber(n.id)
      if (row) emit('number.status', numberView(row))
    },
    onMessage: (m: Incoming, history?: boolean) => { try { ingest(n.id, m, { silent: history }) } catch (e) { console.error('[core] ingest failed', e) } },
    onReaction: (r: { targetWaId: string; emoji: string; fromMe: boolean }) => {
      const msg = db.prepare('SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.number_id = ? AND m.wa_id = ?').get(n.id, r.targetWaId) as any
      if (msg && r.emoji) emit('message.reaction', { message: messageView(msg), chat: getChat(msg.chat_id), reaction: { emoji: r.emoji, from_team: r.fromMe } })
    },
    onReceipt: (waId: string, status: string) => {
      const msg = db.prepare("SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.number_id = ? AND m.wa_id = ? AND m.direction = 'out'").get(n.id, waId) as any
      const rank: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 }
      if (!msg || (rank[status] ?? 0) <= (rank[msg.status] ?? 0)) return
      db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, msg.id)
      emit('message.updated', { message: messageView({ ...msg, status }) })
    },
  }
  const t = n.kind === 'sandbox' ? new SandboxTransport(handlers) : new BaileysTransport(n.id, handlers)
  transports.set(n.id, t)
  await t.start()
}
export async function removeNumber(numberId: string) {
  await transports.get(numberId)?.logout().catch(() => {})
  transports.delete(numberId)
  qrCodes.delete(numberId)
  db.prepare('DELETE FROM numbers WHERE id = ?').run(numberId)
}
export async function startAllNumbers() {
  // The send queue lives in memory. Anything still waiting when the process stopped is marked failed
  // rather than re-sent, because a message may already have gone out just before the restart.
  db.prepare(`UPDATE messages SET status = 'failed', error = 'Interrupted by a server restart. Send again if needed.' WHERE status = 'pending'`).run()
  for (const n of db.prepare('SELECT * FROM numbers').all() as any[]) {
    startNumber(n).catch((e) => console.error(`[core] could not start number ${n.name}`, e))
  }
}

// ---------- views ----------
export function chatView(c: any) {
  if (!c) return c
  const labels = db.prepare('SELECT l.* FROM labels l JOIN chat_labels cl ON cl.label_id = l.id WHERE cl.chat_id = ? ORDER BY l.name').all(c.id)
  let props: Record<string, string> = {}
  try { props = JSON.parse(c.props || '{}') } catch { /* keep empty */ }
  return { ...c, labels, props, internal: !!c.internal }
}
export function messageView(m: any) {
  if (!m) return m
  const { media_path, ...rest } = m
  return { ...rest, media_url: media_path ? `/api/v1/media/${m.id}` : null }
}
export const getChat = (chatId: string) => chatView(db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId))
export const getMessage = (messageId: string) => db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as any

export function listChats(f: { needs_reply?: boolean; q?: string; number_id?: string; label?: string; assignee?: string; status?: string; unread?: boolean; type?: string; limit?: number }) {
  const where: string[] = []
  const args: any[] = []
  if (f.q) { where.push('(c.name LIKE ? OR c.phone LIKE ? OR c.last_message_preview LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`) }
  if (f.number_id) { where.push('c.number_id = ?'); args.push(f.number_id) }
  if (f.status) { where.push('c.status = ?'); args.push(f.status) }
  if (f.type) { where.push('c.type = ?'); args.push(f.type) }
  if (f.unread) where.push('c.unread > 0')
  // Waiting on us: the customer spoke last and the chat is still open.
  if (f.needs_reply) where.push(`c.status = 'open' AND c.internal = 0 AND (SELECT m.direction FROM messages m WHERE m.chat_id = c.id AND m.direction != 'note' ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) = 'in'`)
  if (f.assignee === 'none') where.push('c.assignee_id IS NULL')
  else if (f.assignee) { where.push('c.assignee_id = ?'); args.push(f.assignee) }
  if (f.label) { where.push('EXISTS (SELECT 1 FROM chat_labels cl WHERE cl.chat_id = c.id AND cl.label_id = ?)'); args.push(f.label) }
  const sql = `SELECT c.* FROM chats c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ?`
  return (db.prepare(sql).all(...args, Math.min(f.limit || 200, 500)) as any[]).map(chatView)
}
export function listMessages(chatId: string, opts: { before?: number; limit?: number } = {}) {
  const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(chatId, opts.before || Number.MAX_SAFE_INTEGER, Math.min(opts.limit || 100, 500)) as any[]
  return rows.reverse().map(messageView)
}

// ---------- chats ----------
export function upsertChat(numberId: string, jid: string, info: { type?: string; name?: string; phone?: string }) {
  const existing = (db.prepare('SELECT * FROM chats WHERE number_id = ? AND jid = ?').get(numberId, jid)
    // Same person reached under a different address form (LID vs phone number): reuse their chat.
    ?? (info.phone && info.type !== 'group' ? db.prepare(`SELECT * FROM chats WHERE number_id = ? AND phone = ? AND type = 'dm'`).get(numberId, info.phone) : undefined)) as any
  if (existing) {
    // Group subjects follow WhatsApp. A contact's name is only filled in while it is still the
    // phone-number placeholder, so a name your team typed is never overwritten.
    const placeholder = !existing.name || existing.name === existing.phone || existing.name === existing.jid.split('@')[0]
    if (!(existing.type === 'group' || placeholder)) info = { ...info, name: undefined }
    if ((info.name && info.name !== existing.name) || (info.phone && !existing.phone)) {
      db.prepare('UPDATE chats SET name = COALESCE(?, name), phone = COALESCE(phone, ?) WHERE id = ?').run(info.name ?? null, info.phone ?? null, existing.id)
      return { chat: db.prepare('SELECT * FROM chats WHERE id = ?').get(existing.id) as any, created: false }
    }
    return { chat: existing, created: false }
  }
  const chatId = id('cht')
  db.prepare('INSERT INTO chats(id, number_id, jid, type, name, phone, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(chatId, numberId, jid, info.type || 'dm', info.name || info.phone || jid.split('@')[0], info.phone ?? null, now())
  return { chat: db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as any, created: true }
}
export function updateChat(chatId: string, patch: Record<string, any>) {
  const allowed = ['assignee_id', 'status', 'ai_mode', 'name', 'unread', 'props', 'internal', 'ai_snooze_until']
  patch = { ...patch }
  if (patch.props && typeof patch.props === 'object') patch.props = JSON.stringify(Object.fromEntries(Object.entries(patch.props).filter(([k, v]) => k.trim() && v != null && v !== '').map(([k, v]) => [k.trim(), String(v)])))
  else delete patch.props
  if ('internal' in patch) patch.internal = patch.internal ? 1 : 0
  const keys = Object.keys(patch).filter((k) => allowed.includes(k))
  if (keys.length) db.prepare(`UPDATE chats SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), chatId)
  const chat = getChat(chatId)
  if (chat) emit('chat.updated', { chat })
  return chat
}
export function addLabel(chatId: string, nameOrId: string) {
  let label = db.prepare('SELECT * FROM labels WHERE id = ? OR name = ? COLLATE NOCASE').get(nameOrId, nameOrId) as any
  if (!label) {
    const colors = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777']
    label = { id: id('lbl'), name: nameOrId, color: colors[Math.floor(Math.random() * colors.length)] }
    db.prepare('INSERT INTO labels(id, name, color) VALUES(?,?,?)').run(label.id, label.name, label.color)
  }
  db.prepare('INSERT OR IGNORE INTO chat_labels(chat_id, label_id) VALUES(?,?)').run(chatId, label.id)
  return updateChat(chatId, {})
}
export function removeLabel(chatId: string, nameOrId: string) {
  db.prepare('DELETE FROM chat_labels WHERE chat_id = ? AND label_id IN (SELECT id FROM labels WHERE id = ? OR name = ? COLLATE NOCASE)').run(chatId, nameOrId, nameOrId)
  return updateChat(chatId, {})
}
export function assignChat(chatId: string, userId: string | null) {
  if (userId === 'round_robin') {
    // The teammate with the fewest open chats gets the next one.
    const u = db.prepare(`SELECT u.id FROM users u LEFT JOIN chats c ON c.assignee_id = u.id AND c.status = 'open' GROUP BY u.id ORDER BY COUNT(c.id), u.created_at LIMIT 1`).get() as any
    userId = u?.id ?? null
  }
  return updateChat(chatId, { assignee_id: userId })
}

// ---------- messages ----------
function saveMedia(messageId: string, buffer: Buffer) {
  const p = path.join(DATA_DIR, 'media', messageId)
  fs.writeFileSync(p, buffer)
  return p
}
function preview(type: string, text: string) {
  return (text || `[${type}]`).slice(0, 140)
}

const STALE_MS = 10 * 60_000
/** Store a message from WhatsApp. `silent` is for history sync: no unread count, no events, no automations. */
export function ingest(numberId: string, m: Incoming, opts: { silent?: boolean } = {}) {
  const { chat, created } = upsertChat(numberId, m.jid, { type: m.chatType, name: m.chatName, phone: m.phone })
  if (db.prepare('SELECT 1 FROM messages WHERE chat_id = ? AND wa_id = ?').get(chat.id, m.waId)) return
  const messageId = id('msg')
  const mediaPath = m.media ? saveMedia(messageId, m.media.buffer) : null
  db.prepare(`INSERT INTO messages(id, chat_id, wa_id, direction, sender_jid, sender_name, type, text, media_path, media_mime, media_name, status, sent_by, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(messageId, chat.id, m.waId, m.fromMe ? 'out' : 'in', m.senderJid ?? null, m.senderName ?? null, m.type, m.text,
    mediaPath, m.media?.mime ?? null, m.media?.name ?? null, m.fromMe ? 'sent' : 'received', m.fromMe ? 'phone' : null, m.timestamp)
  const bump = m.fromMe || opts.silent ? 0 : 1
  if (m.timestamp >= (chat.last_message_at || 0)) {
    db.prepare(`UPDATE chats SET last_message_at = ?, last_message_preview = ?, unread = unread + ?, status = CASE WHEN ? THEN 'open' ELSE status END WHERE id = ?`)
      .run(m.timestamp, preview(m.type, m.text), bump, bump, chat.id)
  } else if (bump) db.prepare(`UPDATE chats SET unread = unread + 1, status = 'open' WHERE id = ?`).run(chat.id)
  if (opts.silent) return
  const fresh = getChat(chat.id)
  const message = messageView(getMessage(messageId))
  const stale = now() - m.timestamp > STALE_MS
  if (created) emit('chat.created', { chat: fresh }, { stale })
  emit(m.fromMe ? 'message.sent' : 'message.received', { message, chat: fresh }, { sentBy: m.fromMe ? 'phone' : undefined, stale })
}

const queues = new Map<string, Promise<void>>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const between = (a: number, b: number) => a + Math.random() * Math.max(0, b - a)

export function sendMessage(input: { chatId: string; text?: string; media?: { buffer: Buffer; mime: string; name?: string }; sentBy: string; senderName?: string }) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(input.chatId) as any
  if (!chat) throw new Error('Chat not found')
  const text = (input.text || '').trim()
  if (!text && !input.media) throw new Error('Message is empty')
  const messageId = id('msg')
  const type = input.media ? (input.media.mime.startsWith('image/') ? 'image' : input.media.mime.startsWith('video/') ? 'video' : input.media.mime.startsWith('audio/') ? 'audio' : 'document') : 'text'
  const mediaPath = input.media ? saveMedia(messageId, input.media.buffer) : null
  db.prepare(`INSERT INTO messages(id, chat_id, direction, sender_name, type, text, media_path, media_mime, media_name, status, sent_by, created_at)
    VALUES(?,?,'out',?,?,?,?,?,?,'pending',?,?)`).run(messageId, chat.id, input.senderName ?? null, type, text, mediaPath, input.media?.mime ?? null, input.media?.name ?? null, input.sentBy, now())
  db.prepare('UPDATE chats SET last_message_at = ?, last_message_preview = ?, unread = 0 WHERE id = ?').run(now(), preview(type, text), chat.id)
  emit('message.created', { message: messageView(getMessage(messageId)), chat: getChat(chat.id) })

  const human = input.sentBy.startsWith('user:')
  const broadcast = input.sentBy.startsWith('broadcast:')
  const job = async () => {
    try {
      const s = getSetting('sending')
      if (broadcast) {
        const since = new Date().setHours(0, 0, 0, 0)
        const sentToday = (db.prepare(`SELECT COUNT(*) n FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.number_id = ? AND m.sent_by LIKE 'broadcast:%' AND m.status != 'failed' AND m.status != 'pending' AND m.created_at >= ?`).get(chat.number_id, since) as any).n
        if (sentToday >= s.broadcastDailyLimit) throw new Error(`Daily broadcast limit (${s.broadcastDailyLimit}) reached for this number`)
        await sleep(between(s.broadcastMinDelayMs, s.broadcastMaxDelayMs))
      } else if (!human) await sleep(between(s.minDelayMs, s.maxDelayMs))
      const t = transports.get(chat.number_id)
      if (!t) throw new Error('Number is not connected')
      const waId = input.media ? await t.sendMedia(chat.jid, input.media, text) : await t.sendText(chat.jid, text)
      // A delivery receipt can land before this line; never downgrade a status that already advanced.
      db.prepare(`UPDATE messages SET wa_id = ?, status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END WHERE id = ?`).run(waId, messageId)
      emit('message.sent', { message: messageView(getMessage(messageId)), chat: getChat(chat.id) }, { sentBy: input.sentBy })
    } catch (e: any) {
      db.prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`).run(String(e?.message || e), messageId)
      emit('message.updated', { message: messageView(getMessage(messageId)) })
    }
  }
  // Broadcasts pace themselves in their own lane so they never hold up a teammate's or the agent's reply.
  const lane = broadcast ? `${chat.number_id}:bulk` : chat.number_id
  const tail = (queues.get(lane) ?? Promise.resolve()).then(job)
  queues.set(lane, tail)
  return { message: messageView(getMessage(messageId)), done: tail }
}

/** True when bots have sent a burst into this chat with no human in between: almost always a bot-to-bot loop. */
export function autoReplyLimitReached(chatId: string, max = 8, windowMs = 10 * 60_000) {
  const rows = db.prepare(`SELECT sent_by FROM messages WHERE chat_id = ? AND direction = 'out' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(chatId, now() - windowMs, max) as any[]
  return rows.length >= max && rows.every((r) => /^(ai|automation:)/.test(r.sent_by || ''))
}

export function addNote(chatId: string, text: string, author: string) {
  const messageId = id('msg')
  db.prepare(`INSERT INTO messages(id, chat_id, direction, sender_name, type, text, status, sent_by, created_at) VALUES(?,?,'note',?,'text',?,'sent',?,?)`)
    .run(messageId, chatId, author, text, author, now())
  const message = messageView(getMessage(messageId))
  emit('note.created', { message, chat: getChat(chatId) })
  return message
}

/** Open (or find) a direct chat with a phone number on a given connected number. */
export async function chatForPhone(numberId: string, phone: string, name?: string) {
  const t = transports.get(numberId)
  if (!t) throw new Error('Number is not connected')
  const jid = phone.includes('@') ? phone : await t.resolveJid(phone)
  const { chat, created } = upsertChat(numberId, jid, { type: jid.endsWith('@g.us') ? 'group' : 'dm', name, phone: jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : undefined })
  if (created) emit('chat.created', { chat: getChat(chat.id) })
  return getChat(chat.id)
}

// ---------- tickets ----------
export function createTicket(t: { chatId?: string | null; messageId?: string | null; title: string; description?: string; priority?: string; assigneeId?: string | null; createdBy: string }) {
  const ticketId = id('tkt')
  const seq = ((db.prepare('SELECT MAX(seq) s FROM tickets').get() as any).s || 0) + 1
  db.prepare(`INSERT INTO tickets(id, seq, chat_id, message_id, title, description, priority, assignee_id, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ticketId, seq, t.chatId ?? null, t.messageId ?? null, t.title.slice(0, 200), t.description ?? null,
      ['low', 'medium', 'high', 'urgent'].includes(t.priority || '') ? t.priority : 'medium', t.assigneeId ?? null, t.createdBy, now(), now())
  const ticket = getTicket(ticketId)
  emit('ticket.created', { ticket, chat: ticket.chat_id ? getChat(ticket.chat_id) : null })
  return ticket
}
export const getTicket = (ticketId: string) => db.prepare('SELECT t.*, c.name AS chat_name FROM tickets t LEFT JOIN chats c ON c.id = t.chat_id WHERE t.id = ?').get(ticketId) as any
export function updateTicket(ticketId: string, patch: Record<string, any>) {
  const allowed = ['title', 'description', 'status', 'priority', 'assignee_id']
  const keys = Object.keys(patch).filter((k) => allowed.includes(k))
  if (keys.length) db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k]), now(), ticketId)
  const ticket = getTicket(ticketId)
  if (ticket) emit('ticket.updated', { ticket, chat: ticket.chat_id ? getChat(ticket.chat_id) : null })
  return ticket
}
