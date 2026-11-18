import crypto from 'node:crypto'
import { db, id, now } from './db.js'
import { bus, type AppEvent } from './bus.js'
import { sendMessage } from './core.js'
import { buildContext, executeAutomation, listAutomations, localNow, render, runAutomations, runTimedAutomations } from './automations.js'
import { addNote, clearFlags, getChat, looksImportant, setFlag, updateChat } from './core.js'
import { getSetting } from './db.js'
import { aiConfigured, aiShouldFlag } from './ai.js'
import { maybeAutoReply, snoozeAgent } from './ai.js'
import { maybeScheduledTraining } from './training.js'

// ---------- outgoing webhooks ----------
async function deliver(hook: any, evt: AppEvent) {
  const body = JSON.stringify({ event: evt.event, data: evt.data, timestamp: now() })
  const signature = `sha256=${crypto.createHmac('sha256', hook.secret).update(body).digest('hex')}`
  let attempts = 0, ok = false, statusCode: number | null = null, error: string | null = null
  for (const wait of [0, 1000, 5000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait))
    attempts++
    try {
      const res = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-switchboard-signature': signature, 'x-switchboard-event': evt.event }, body, signal: AbortSignal.timeout(10000) })
      statusCode = res.status; ok = res.ok; error = ok ? null : `HTTP ${res.status}`
    } catch (e: any) { error = String(e?.message || e) }
    if (ok) break
  }
  db.prepare('INSERT INTO webhook_deliveries(id, webhook_id, event, ok, status_code, attempts, error, created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id('whd'), hook.id, evt.event, ok ? 1 : 0, statusCode, attempts, error, now())
  db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 100)').run(hook.id, hook.id)
}

const WEBHOOK_EVENTS = ['message.received', 'message.sent', 'message.updated', 'chat.created', 'chat.updated', 'ticket.created', 'ticket.updated', 'number.status']

export function startBackground() {
  bus.on('event', (evt: AppEvent) => {
    if (WEBHOOK_EVENTS.includes(evt.event)) {
      for (const hook of db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all() as any[]) {
        const events: string[] = JSON.parse(hook.events)
        if (events.includes('*') || events.includes(evt.event)) deliver(hook, evt).catch(() => {})
      }
    }
    // Backlog delivered after downtime is stored and shown, but never auto-answered hours late.
    if (evt.meta?.stale) return
    if (evt.event === 'message.sent' && /^(user:|phone$)/.test(evt.meta?.sentBy || '')) snoozeAgent(evt.data.chat.id)
    // Any real reply (teammate, phone, AI agent, API) answers what was flagged. Broadcasts and rule-based sends do not.
    if (evt.event === 'message.sent' && /^(user:|phone$|ai$|api$|mcp$)/.test(evt.meta?.sentBy || '')) clearFlags(evt.data.chat.id)
    if (evt.event === 'message.received' && !evt.data.chat.internal && evt.data.message?.text) {
      const mode = getSetting('flagging').mode, text = evt.data.message.text as string
      if (mode === 'smart' && looksImportant(text)) setFlag(evt.data.message.id, true)
      if (mode === 'ai') (aiConfigured() ? aiShouldFlag(text).catch(() => looksImportant(text)) : Promise.resolve(looksImportant(text))).then((yes) => { if (yes) setFlag(evt.data.message.id, true) })
    }
    // Automations run first; the AI agent only steps in when no automation already answered.
    runAutomations(evt)
      .then((replied) => {
        if (evt.event === 'message.received' && !replied && evt.data.message?.text && evt.data.message.type !== 'other') return maybeAutoReply(evt.data.chat.id)
      })
      .catch((e) => console.error('[automation] failed', e))
  })
  setInterval(() => tick().catch((e) => console.error('[scheduler] failed', e)), Number(process.env.TICK_MS) || 15_000).unref()
}

// ---------- scheduler ----------
export async function tick() {
  for (const s of db.prepare(`SELECT * FROM scheduled WHERE status = 'pending' AND send_at <= ?`).all(now()) as any[]) {
    const chatIds: string[] = JSON.parse(s.chat_ids)
    const period = s.repeat === 'daily' ? 86_400_000 : s.repeat === 'weekly' ? 604_800_000 : 0
    if (period) {
      let next = s.send_at
      while (next <= now()) next += period
      db.prepare('UPDATE scheduled SET send_at = ?, sent_count = sent_count + ? WHERE id = ?').run(next, chatIds.length, s.id)
    } else db.prepare(`UPDATE scheduled SET status = 'sent', sent_count = ? WHERE id = ?`).run(chatIds.length, s.id)
    for (const chatId of chatIds) {
      try { sendMessage({ chatId, text: render(s.text, buildContext({ chat: getChat(chatId) })), sentBy: `${chatIds.length > 1 ? 'broadcast' : 'scheduled'}:${s.id}`, senderName: s.name || 'Scheduled' }) } catch { /* chat was deleted */ }
    }
  }
  // Follow-up reminders a teammate set on a chat: bring it back to the top with a note.
  for (const c of db.prepare('SELECT id, follow_up_note FROM chats WHERE follow_up_at IS NOT NULL AND follow_up_at <= ? AND follow_up_notified = 0').all(now()) as any[]) {
    db.prepare('UPDATE chats SET follow_up_notified = 1, unread = unread + 1, last_message_at = ? WHERE id = ?').run(now(), c.id)
    addNote(c.id, `Follow-up reminder${c.follow_up_note ? `: ${c.follow_up_note}` : ''}`, 'Reminder')
    updateChat(c.id, {})
  }
  await runTimedAutomations()
  maybeScheduledTraining().catch((e) => console.error('[training] failed', e))
  const local = localNow()
  const hhmm = local.toISOString().slice(11, 16)
  const key = `${local.toISOString().slice(0, 10)} ${hhmm}`
  for (const auto of listAutomations()) {
    if (!auto.enabled || auto.trigger.type !== 'schedule' || auto.trigger.time !== hhmm) continue
    if (auto.trigger.days?.length && !auto.trigger.days.includes(local.getUTCDay())) continue
    const claimed = db.prepare('UPDATE automations SET last_schedule_key = ? WHERE id = ? AND (last_schedule_key IS NULL OR last_schedule_key != ?)').run(key, auto.id, key)
    if (claimed.changes) await executeAutomation(auto, buildContext({}), `schedule ${key}`)
  }
}
