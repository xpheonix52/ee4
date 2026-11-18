import Anthropic from '@anthropic-ai/sdk'
import { db, getSetting } from './db.js'
import { addLabel, addNote, assignChat, autoReplyLimitReached, createTicket, getChat, sendMessage, updateChat } from './core.js'
import { searchKnowledge } from './knowledge.js'
import { externalTools } from './mcpClient.js'

export type Tool = { name: string; description: string; schema: any; run: (input: any) => Promise<string> }
type Turn = { role: 'user' | 'assistant'; text: string }
export type AgentResult = { text: string; trace: { tool: string; input: any; output: string }[] }

export const aiConfigured = () => !!getSetting('ai').apiKey
const MAX_STEPS = 8

async function callTool(tools: Tool[], name: string, input: any, trace: AgentResult['trace']) {
  const tool = tools.find((t) => t.name === name)
  let output: string
  try { output = tool ? await tool.run(input || {}) : `Unknown tool: ${name}` } catch (e: any) { output = `Tool failed: ${e?.message || e}` }
  trace.push({ tool: name, input, output: output.slice(0, 2000) })
  return output
}

async function runAnthropic(system: string, turns: Turn[], tools: Tool[]): Promise<AgentResult> {
  const cfg = getSetting('ai')
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}) })
  const messages: Anthropic.MessageParam[] = turns.map((t) => ({ role: t.role, content: t.text }))
  const trace: AgentResult['trace'] = []
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await client.messages.create({
      model: cfg.model, max_tokens: 16000, system, messages,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}),
    })
    if (res.stop_reason === 'refusal') throw new Error('The model declined to answer this request')
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim()
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (res.stop_reason !== 'tool_use' || !uses.length) return { text, trace }
    messages.push({ role: 'assistant', content: res.content })
    const results = await Promise.all(uses.map(async (u) => ({
      type: 'tool_result' as const, tool_use_id: u.id, content: await callTool(tools, u.name, u.input, trace),
    })))
    messages.push({ role: 'user', content: results })
  }
  throw new Error('The agent did not finish within the step limit')
}

async function runOpenAI(system: string, turns: Turn[], tools: Tool[]): Promise<AgentResult> {
  const cfg = getSetting('ai')
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const messages: any[] = [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))]
  const trace: AgentResult['trace'] = []
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model, messages,
        ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}),
      }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) throw new Error(`AI provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const msg = ((await res.json()) as any).choices?.[0]?.message
    if (!msg) throw new Error('AI provider returned an empty response')
    const calls: any[] = msg.tool_calls || []
    if (!calls.length) return { text: String(msg.content || '').trim(), trace }
    messages.push(msg)
    for (const c of calls) {
      let input: any = {}
      try { input = JSON.parse(c.function.arguments || '{}') } catch { /* model sent malformed arguments */ }
      messages.push({ role: 'tool', tool_call_id: c.id, content: await callTool(tools, c.function.name, input, trace) })
    }
  }
  throw new Error('The agent did not finish within the step limit')
}

export async function runModel(system: string, turns: Turn[], tools: Tool[] = []): Promise<AgentResult> {
  if (!aiConfigured()) throw new Error('AI is not configured yet. Add a provider key under AI Agent.')
  while (turns.length && turns[0].role !== 'user') turns = turns.slice(1)
  if (!turns.length) throw new Error('Nothing to respond to')
  return getSetting('ai').provider === 'openai' ? runOpenAI(system, turns, tools) : runAnthropic(system, turns, tools)
}

const knowledgeTool: Tool = {
  name: 'search_knowledge', description: 'Search the company knowledge hub (FAQs, policies, docs). Call this before answering any factual question about the business.',
  schema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords to search for' } }, required: ['query'] },
  run: async ({ query }) => {
    const hits = searchKnowledge(String(query || ''))
    return hits.length ? hits.map((h) => `## ${h.title}\n${h.body}`).join('\n\n---\n\n') : 'No matching knowledge found.'
  },
}

function chatTools(chatId: string, dryRun: boolean): Tool[] {
  const guard = (fn: () => string) => async () => (dryRun ? '(test mode: action not performed) ok' : fn())
  return [
    knowledgeTool,
    {
      name: 'create_ticket', description: 'Create a support ticket for the team when the customer reports an issue or makes a request that needs follow-up.',
      schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] } }, required: ['title'] },
      run: (i) => guard(() => `Created ticket #${createTicket({ chatId, title: String(i.title), description: i.description, priority: i.priority, createdBy: 'ai' }).seq}`)(),
    },
    {
      name: 'add_label', description: 'Tag this chat with a label (for example "Lead", "Billing", "VIP").',
      schema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] },
      run: (i) => guard(() => { addLabel(chatId, String(i.label)); return 'Label added' })(),
    },
    {
      name: 'handoff_to_human', description: 'Hand this conversation to a human teammate. Use when you cannot answer confidently, the customer is upset, or they ask for a person.',
      schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      run: (i) => guard(() => {
        updateChat(chatId, { ai_mode: 'off' })
        addLabel(chatId, 'Needs human')
        if (!getChat(chatId)?.assignee_id) assignChat(chatId, 'round_robin')
        addNote(chatId, `AI handed off: ${i.reason}`, 'AI agent')
        return `Handed off. Now send the customer this short message and nothing else: "${getSetting('ai').handoffMessage}"`
      })(),
    },
  ]
}

function history(chatId: string, limit = 30): Turn[] {
  const rows = db.prepare(`SELECT direction, text, type, sender_name FROM messages WHERE chat_id = ? AND direction != 'note' AND status != 'failed' ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(chatId, limit) as any[]
  const chat = getChat(chatId)
  return rows.reverse().map((m) => ({
    role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
    text: (chat?.type === 'group' && m.direction === 'in' ? `${m.sender_name || 'Member'}: ` : '') + (m.text || `[${m.type}]`),
  }))
}

function systemPrompt(chatId: string) {
  const cfg = getSetting('ai')
  const chat = getChat(chatId)
  return `${cfg.instructions}

Your name is ${cfg.agentName}. You work for ${getSetting('workspace').name}.
You are chatting on WhatsApp with ${chat?.name || 'a customer'}${chat?.type === 'group' ? ' (a group chat)' : ''}.
Write like a person texting: short plain-text messages, no markdown headings or tables.
Never invent facts about the business. If the knowledge hub has no answer, say you will check and hand off to a human.`
}

/** Run the AI agent over a chat's history. With dryRun nothing is sent or changed. */
export async function agentReply(chatId: string, opts: { dryRun?: boolean; extra?: string } = {}) {
  const turns = history(chatId)
  if (opts.extra) turns.push({ role: 'user', text: opts.extra })
  const tools = [...chatTools(chatId, !!opts.dryRun), ...(await externalTools())]
  return runModel(systemPrompt(chatId), turns, tools)
}

/** Free-form generation used by automations, reply drafts and summaries. */
export async function generate(prompt: string, opts: { chatId?: string; useKnowledge?: boolean } = {}) {
  const transcript = opts.chatId
    ? (db.prepare(`SELECT direction, text, sender_name FROM messages WHERE chat_id = ? AND direction != 'note' ORDER BY created_at DESC LIMIT 40`).all(opts.chatId) as any[])
        .reverse().map((m) => `${m.direction === 'in' ? m.sender_name || 'Customer' : 'Us'}: ${m.text}`).join('\n')
    : ''
  const cfg = getSetting('ai')
  const system = `${cfg.instructions}\nYou work for ${getSetting('workspace').name}. Reply with the requested output only, no preamble.`
  const user = transcript ? `Conversation so far:\n${transcript}\n\nTask: ${prompt}` : prompt
  return (await runModel(system, [{ role: 'user', text: user }], opts.useKnowledge ? [knowledgeTool] : [])).text
}

const busy = new Set<string>()
const again = new Set<string>()
/** Auto-reply to an incoming message when the agent is switched on for this chat. */
export async function maybeAutoReply(chatId: string) {
  const chat = getChat(chatId)
  if (!chat || !aiConfigured()) return
  const number = db.prepare('SELECT * FROM numbers WHERE id = ?').get(chat.number_id) as any
  const on = chat.ai_mode === 'on' || (chat.ai_mode === 'default' && number?.ai_enabled)
  if (!on || (chat.type === 'group' && !getSetting('ai').replyInGroups)) return
  if (autoReplyLimitReached(chatId)) {
    updateChat(chatId, { ai_mode: 'off' })
    addNote(chatId, 'AI agent paused itself here: too many automatic replies in a row without a teammate. This usually means the other side is also a bot. Switch the agent back on in the chat details when ready.', 'AI agent')
    return
  }
  if (busy.has(chatId)) { again.add(chatId); return }
  busy.add(chatId)
  try {
    do {
      again.delete(chatId)
      const { text } = await agentReply(chatId)
      if (text) await sendMessage({ chatId, text, sentBy: 'ai', senderName: getSetting('ai').agentName }).done
    } while (again.has(chatId))
  } catch (e: any) {
    addNote(chatId, `AI agent could not reply: ${e?.message || e}`, 'AI agent')
  } finally {
    busy.delete(chatId)
  }
}
