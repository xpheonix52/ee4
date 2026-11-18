import { db, id, now, getSetting, token } from './db.js'
import { emit, type AppEvent } from './bus.js'
import { addLabel, addNote, assignChat, createTicket, getChat, getNumber, removeLabel, sendMessage, updateChat } from './core.js'
import { agentReply, generate } from './ai.js'

export const TRIGGERS = ['message.received', 'message.sent', 'chat.created', 'ticket.created', 'ticket.updated', 'webhook', 'schedule'] as const
export type Condition = { field: string; op: string; value?: string }
export type Action = { type: string; [k: string]: any }
export type Automation = {
  id: string; name: string; enabled: boolean; trigger: { type: string; time?: string; days?: number[] }
  conditions: Condition[]; match: 'all' | 'any'; actions: Action[]; cooldown_minutes: number; hook_token: string; run_count: number; created_at: number
}

export function automationView(r: any): Automation {
  return { ...r, enabled: !!r.enabled, trigger: JSON.parse(r.trigger), conditions: JSON.parse(r.conditions), actions: JSON.parse(r.actions) }
}
export const listAutomations = () => (db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all() as any[]).map(automationView)
export const getAutomation = (autoId: string) => {
  const r = db.prepare('SELECT * FROM automations WHERE id = ?').get(autoId)
  return r ? automationView(r) : null
}
export function saveAutomation(input: Partial<Automation> & { name: string }, autoId?: string) {
  const cur = autoId ? getAutomation(autoId) : null
  const a = {
    name: input.name, enabled: input.enabled ?? cur?.enabled ?? true, trigger: input.trigger ?? cur?.trigger ?? { type: 'message.received' },
    conditions: input.conditions ?? cur?.conditions ?? [], match: input.match ?? cur?.match ?? 'all', actions: input.actions ?? cur?.actions ?? [],
    cooldown_minutes: Number(input.cooldown_minutes ?? cur?.cooldown_minutes ?? 0) || 0,
  }
  if (cur) {
    db.prepare('UPDATE automations SET name=?, enabled=?, trigger=?, conditions=?, match=?, actions=?, cooldown_minutes=? WHERE id=?')
      .run(a.name, a.enabled ? 1 : 0, JSON.stringify(a.trigger), JSON.stringify(a.conditions), a.match, JSON.stringify(a.actions), a.cooldown_minutes, cur.id)
    return getAutomation(cur.id)!
  }
  const newId = id('aut')
  db.prepare('INSERT INTO automations(id, name, enabled, trigger, conditions, match, actions, cooldown_minutes, hook_token, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(newId, a.name, a.enabled ? 1 : 0, JSON.stringify(a.trigger), JSON.stringify(a.conditions), a.match, JSON.stringify(a.actions), a.cooldown_minutes, token(12), now())
  return getAutomation(newId)!
}

// ---------- templating & conditions ----------
const lookup = (ctx: any, path: string) => path.trim().split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx)
export function render(tpl: unknown, ctx: any): string {
  return String(tpl ?? '').replace(/\{\{([^}]+)\}\}/g, (_, p) => {
    const v = lookup(ctx, p)
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  })
}

export function localNow() {
  return new Date(Date.now() + getSetting('workspace').timezoneOffsetMinutes * 60_000)
}
export function inBusinessHours() {
  const bh = getSetting('businessHours')
  const d = localNow()
  const hhmm = d.toISOString().slice(11, 16)
  return bh.days.includes(d.getUTCDay()) && hhmm >= bh.start && hhmm < bh.end
}

function test(c: Condition, ctx: any) {
  const raw = c.field === 'time.business_hours' ? inBusinessHours() : c.field === 'chat.labels' ? (ctx.chat?.labels || []).map((l: any) => l.name).join(',') : lookup(ctx, c.field)
  const actual = String(raw ?? '').toLowerCase()
  const expected = render(c.value, ctx).toLowerCase().trim()
  const list = expected.split(',').map((s) => s.trim()).filter(Boolean)
  switch (c.op) {
    case 'contains': return list.some((v) => actual.includes(v))
    case 'not_contains': return !list.some((v) => actual.includes(v))
    case 'equals': return actual === expected
    case 'not_equals': return actual !== expected
    case 'starts_with': return actual.startsWith(expected)
    case 'matches': try { return new RegExp(render(c.value, ctx), 'i').test(String(raw ?? '')) } catch { return false }
    case 'is_empty': return actual === ''
    case 'is_not_empty': return actual !== ''
    case 'is_true': return raw === true || actual === 'true' || actual === '1'
    case 'is_false': return !(raw === true || actual === 'true' || actual === '1')
    default: return false
  }
}

// ---------- execution ----------
type Step = { action: string; ok: boolean; detail: string }

async function runAction(a: Action, ctx: any, auto: Automation, state: { replied: boolean }): Promise<string> {
  const chatId: string | undefined = a.chat_id || ctx.chat?.id
  const needChat = () => { if (!chatId) throw new Error('This action needs a chat, but the trigger has none. Pick a target chat.'); return chatId }
  switch (a.type) {
    case 'send_message': {
      const text = render(a.text, ctx)
      await sendMessage({ chatId: needChat(), text, sentBy: `automation:${auto.id}`, senderName: auto.name }).done
      state.replied = true
      return `Sent: ${text.slice(0, 80)}`
    }
    case 'ai_reply': {
      const { text } = await agentReply(needChat())
      if (text) await sendMessage({ chatId: needChat(), text, sentBy: 'ai', senderName: getSetting('ai').agentName }).done
      state.replied = true
      return `AI replied: ${text.slice(0, 80)}`
    }
    case 'ai_generate': {
      const out = await generate(render(a.prompt, ctx), { chatId: ctx.chat?.id, useKnowledge: !!a.use_knowledge })
      ctx.ai = { ...(ctx.ai || {}), output: out, [a.save_as || 'output']: out }
      return `AI output: ${out.slice(0, 120)}`
    }
    case 'add_label': addLabel(needChat(), render(a.label, ctx)); return `Label added: ${render(a.label, ctx)}`
    case 'remove_label': removeLabel(needChat(), render(a.label, ctx)); return `Label removed: ${render(a.label, ctx)}`
    case 'assign': assignChat(needChat(), a.user_id || 'round_robin'); return `Assigned to ${a.user_id || 'next available teammate'}`
    case 'set_chat_status': updateChat(needChat(), { status: a.status === 'closed' ? 'closed' : 'open' }); return `Chat marked ${a.status}`
    case 'set_ai_mode': updateChat(needChat(), { ai_mode: ['on', 'off', 'default'].includes(a.mode) ? a.mode : 'default' }); return `AI agent set to ${a.mode}`
    case 'add_note': addNote(needChat(), render(a.text, ctx), auto.name); return 'Note added'
    case 'create_ticket': {
      const t = createTicket({ chatId: chatId ?? null, messageId: ctx.message?.id, title: render(a.title || '{{message.text}}', ctx) || 'New ticket', description: render(a.description, ctx), priority: a.priority, createdBy: `automation:${auto.id}` })
      ctx.ticket = t
      return `Created ticket #${t.seq}`
    }
    case 'http_request': {
      const method = (a.method || 'POST').toUpperCase()
      let headers: Record<string, string> = { 'content-type': 'application/json' }
      try { headers = { ...headers, ...JSON.parse(render(a.headers || '{}', ctx)) } } catch { throw new Error('Headers must be valid JSON') }
      const body = method === 'GET' ? undefined : a.body ? render(a.body, ctx) : JSON.stringify({ automation: auto.name, message: ctx.message, chat: ctx.chat, ticket: ctx.ticket })
      const res = await fetch(render(a.url, ctx), { method, headers, body, signal: AbortSignal.timeout(20000) })
      const text = await res.text()
      let json: any
      try { json = JSON.parse(text) } catch { /* not JSON */ }
      ctx.http = { status: res.status, body: text.slice(0, 4000), json }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return `HTTP ${res.status}`
    }
    case 'wait': await new Promise((r) => setTimeout(r, Math.min(Number(a.seconds) || 0, 300) * 1000)); return `Waited ${a.seconds}s`
    default: throw new Error(`Unknown action: ${a.type}`)
  }
}

export async function executeAutomation(auto: Automation, ctx: any, summary: string) {
  const steps: Step[] = []
  const state = { replied: false }
  let status = 'success'
  for (const a of auto.actions) {
    try { steps.push({ action: a.type, ok: true, detail: await runAction(a, ctx, auto, state) }) }
    catch (e: any) { steps.push({ action: a.type, ok: false, detail: String(e?.message || e) }); status = 'failed'; break }
  }
  const runId = id('run')
  db.prepare('INSERT INTO automation_runs(id, automation_id, chat_id, status, summary, log, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(runId, auto.id, ctx.chat?.id ?? null, status, summary.slice(0, 200), JSON.stringify(steps), now())
  db.prepare('UPDATE automations SET run_count = run_count + 1 WHERE id = ?').run(auto.id)
  db.prepare('DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 200)').run(auto.id, auto.id)
  emit('automation.run', { automation_id: auto.id, name: auto.name, status, steps })
  return { id: runId, status, steps, replied: state.replied }
}

export function buildContext(data: any) {
  const chat = data.chat || (data.message?.chat_id ? getChat(data.message.chat_id) : null)
  return {
    message: data.message, chat, ticket: data.ticket, webhook: data.webhook,
    contact: { name: data.message?.sender_name || chat?.name, phone: chat?.phone },
    number: chat ? getNumber(chat.number_id) : undefined,
    workspace: getSetting('workspace'), now: new Date().toISOString(),
  }
}

/** Run every enabled automation matching this event. Returns true when one of them replied in the chat. */
export async function runAutomations(evt: AppEvent) {
  if (!(TRIGGERS as readonly string[]).includes(evt.event)) return false
  if (evt.event === 'message.sent' && /^(automation|ai|broadcast|scheduled)/.test(evt.meta?.sentBy || '')) return false
  if (evt.event === 'ticket.created' && /^automation:/.test(evt.data.ticket?.created_by || '')) return false
  let replied = false
  for (const auto of listAutomations()) {
    if (!auto.enabled || auto.trigger.type !== evt.event) continue
    const ctx = buildContext(evt.data)
    const results = auto.conditions.map((c) => test(c, ctx))
    const pass = !results.length || (auto.match === 'any' ? results.some(Boolean) : results.every(Boolean))
    if (!pass) continue
    if (auto.cooldown_minutes && ctx.chat) {
      const last = db.prepare('SELECT created_at FROM automation_runs WHERE automation_id = ? AND chat_id = ? ORDER BY created_at DESC LIMIT 1').get(auto.id, ctx.chat.id) as any
      if (last && now() - last.created_at < auto.cooldown_minutes * 60_000) continue
    }
    const r = await executeAutomation(auto, ctx, `${evt.event}: ${ctx.message?.text || ctx.ticket?.title || ctx.chat?.name || ''}`)
    replied ||= r.replied
  }
  return replied
}
