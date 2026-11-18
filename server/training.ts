import { db, getSetting, id, now, localNow } from './db.js'
import { runModel, aiConfigured } from './ai.js'
import { listFaqs, saveFaq } from './knowledge.js'

const WEEK = 7 * 86_400_000
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Self-training: read the past week of conversations where a teammate answered, and draft FAQ entries
 * from the answers they gave. New entries wait for review unless auto-activation is on.
 */
export async function runTraining(trigger: 'manual' | 'scheduled') {
  const runId = id('trn')
  db.prepare('INSERT INTO training_runs(id, status, trigger, created_at) VALUES(?,?,?,?)').run(runId, 'running', trigger, now())
  const finish = (status: string, learned: number, chats: number, error?: string) => {
    db.prepare('UPDATE training_runs SET status = ?, learned = ?, chats = ?, error = ? WHERE id = ?').run(status, learned, chats, error ?? null, runId)
    return db.prepare('SELECT * FROM training_runs WHERE id = ?').get(runId)
  }
  try {
    if (!aiConfigured()) throw new Error('Add an AI provider key first')
    const since = now() - WEEK
    const chats = db.prepare(`SELECT DISTINCT chat_id FROM messages WHERE created_at >= ? AND direction = 'out' AND (sent_by LIKE 'user:%' OR sent_by = 'phone') LIMIT 60`).all(since) as { chat_id: string }[]
    const known = new Set(listFaqs().flatMap((f) => f.questions.map(norm)))
    const status = getSetting('ai').selfLearnApproval ? 'review' : 'active'
    let learned = 0
    for (const { chat_id } of chats) {
      const rows = db.prepare(`SELECT direction, text, sent_by FROM messages WHERE chat_id = ? AND created_at >= ? AND direction != 'note' AND text != '' ORDER BY created_at LIMIT 80`).all(chat_id, since) as any[]
      const transcript = rows.map((m) => `${m.direction === 'in' ? 'CUSTOMER' : /^(user:|phone)/.test(m.sent_by || '') ? 'TEAM' : 'BOT'}: ${m.text}`).join('\n').slice(0, 12_000)
      const { text } = await runModel(
        'You build a support knowledge base. Reply with a JSON array only, no prose.',
        [{ role: 'user', text: `From this WhatsApp conversation, extract reusable Q&A pairs: a question a customer asked, and the answer a human TEAM member gave.\nRules: only use answers written by TEAM (never BOT). Skip anything specific to this one customer (names, order numbers, personal data), small talk, and unanswered questions. Rewrite each answer as a general statement any customer could be told. If nothing qualifies, return [].\nFormat: [{"question": "...", "answer": "..."}]\n\nConversation:\n${transcript}` }],
      )
      let pairs: any[] = []
      try { pairs = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) } catch { /* the model returned nothing usable for this chat */ }
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const q = String(p?.question || '').trim(), a = String(p?.answer || '').trim()
        if (!q || !a || known.has(norm(q))) continue
        known.add(norm(q))
        saveFaq({ questions: [q], answer: a, status, source: 'learned' })
        learned++
      }
    }
    return finish('complete', learned, chats.length)
  } catch (e: any) {
    return finish('failed', 0, 0, String(e?.message || e))
  }
}

/** Runs once a week (Sunday, workspace time) when weekly self-training is switched on. */
export async function maybeScheduledTraining() {
  if (!getSetting('ai').selfTrainWeekly || !aiConfigured() || localNow().getUTCDay() !== 0) return
  const last = db.prepare('SELECT created_at FROM training_runs ORDER BY created_at DESC LIMIT 1').get() as any
  if (last && now() - last.created_at < 6 * 86_400_000) return
  await runTraining('scheduled')
}
