import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Request, Response } from 'express'
import { db } from './db.js'
import { addLabel, addNote, assignChat, chatForPhone, createTicket, listChats, listMessages, listNumbers, sendMessage, updateTicket } from './core.js'
import { addDoc, searchKnowledge } from './knowledge.js'
import { listAutomations, saveAutomation, TRIGGERS } from './automations.js'

const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] })
const slimChat = (c: any) => ({ id: c.id, name: c.name, phone: c.phone, type: c.type, number_id: c.number_id, unread: c.unread, status: c.status, assignee_id: c.assignee_id, last_message: c.last_message_preview, last_message_at: c.last_message_at, labels: c.labels.map((l: any) => l.name) })
const slimMsg = (m: any) => ({ id: m.id, direction: m.direction, from: m.sender_name, type: m.type, text: m.text, status: m.status, at: new Date(m.created_at).toISOString() })

function build() {
  const s = new McpServer({ name: 'switchboard', version: '0.1.0' })
  const tool = (name: string, description: string, shape: z.ZodRawShape, run: (a: any) => unknown | Promise<unknown>) =>
    s.registerTool(name, { description, inputSchema: shape }, async (a: any) => {
      try { return json(await run(a)) } catch (e: any) { return { isError: true, content: [{ type: 'text' as const, text: String(e?.message || e) }] } }
    })

  tool('list_numbers', 'List connected WhatsApp numbers and their connection status.', {}, () =>
    listNumbers().map((n: any) => ({ id: n.id, name: n.name, kind: n.kind, phone: n.phone, status: n.status, ai_enabled: n.ai_enabled })))
  tool('list_chats', 'List WhatsApp chats (direct and group), newest first. Filter by search text, unread or status.',
    { query: z.string().optional(), unread_only: z.boolean().optional(), status: z.enum(['open', 'closed']).optional(), limit: z.number().int().min(1).max(100).optional() },
    (a) => listChats({ q: a.query, unread: a.unread_only, status: a.status, limit: a.limit || 30 }).map(slimChat))
  tool('get_chat_messages', 'Read the most recent messages in a chat, oldest first. Includes private team notes (direction "note").',
    { chat_id: z.string(), limit: z.number().int().min(1).max(200).optional() }, (a) => listMessages(a.chat_id, { limit: a.limit || 40 }).map(slimMsg))
  tool('send_message', 'Send a WhatsApp text message. Give chat_id for an existing chat, or number_id plus phone (international format) to message a new contact.',
    { chat_id: z.string().optional(), number_id: z.string().optional(), phone: z.string().optional(), text: z.string().min(1) },
    async (a) => {
      const chatId = a.chat_id || (a.number_id && a.phone ? (await chatForPhone(a.number_id, a.phone)).id : null)
      if (!chatId) throw new Error('Provide chat_id, or number_id and phone')
      return slimMsg(sendMessage({ chatId, text: a.text, sentBy: 'mcp', senderName: 'MCP' }).message)
    })
  tool('add_note', 'Add a private team note to a chat. The customer never sees it.', { chat_id: z.string(), text: z.string().min(1) }, (a) => slimMsg(addNote(a.chat_id, a.text, 'MCP')))
  tool('add_label', 'Add a label to a chat (created if it does not exist).', { chat_id: z.string(), label: z.string().min(1) }, (a) => slimChat(addLabel(a.chat_id, a.label)))
  tool('assign_chat', 'Assign a chat to a teammate by user id, or pass "round_robin" for the least busy teammate.', { chat_id: z.string(), user_id: z.string() }, (a) => slimChat(assignChat(a.chat_id, a.user_id)))
  tool('list_team', 'List teammates (id, name, email, role).', {}, () => db.prepare('SELECT id, name, email, role FROM users ORDER BY name').all())
  tool('search_knowledge', 'Search the knowledge hub and return the most relevant passages.', { query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }, (a) => searchKnowledge(a.query, a.limit || 5).map((h) => ({ title: h.title, text: h.body })))
  tool('add_knowledge', 'Add a document to the knowledge hub so the AI agent can use it.', { title: z.string().min(1), content: z.string().min(1) }, (a) => { const d = addDoc(a); return { id: d.id, title: d.title } })
  tool('list_tickets', 'List tickets, newest first.', { status: z.enum(['open', 'in_progress', 'resolved']).optional(), limit: z.number().int().min(1).max(200).optional() },
    (a) => db.prepare(`SELECT t.*, c.name AS chat_name FROM tickets t LEFT JOIN chats c ON c.id = t.chat_id ${a.status ? 'WHERE t.status = ?' : ''} ORDER BY t.created_at DESC LIMIT ?`).all(...(a.status ? [a.status] : []), a.limit || 50))
  tool('create_ticket', 'Create a ticket, optionally linked to a chat.', { title: z.string().min(1), description: z.string().optional(), chat_id: z.string().optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional() },
    (a) => createTicket({ chatId: a.chat_id, title: a.title, description: a.description, priority: a.priority, createdBy: 'mcp' }))
  tool('update_ticket', 'Update a ticket status, priority, title or assignee.', { ticket_id: z.string(), status: z.enum(['open', 'in_progress', 'resolved']).optional(), priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(), title: z.string().optional(), assignee_id: z.string().optional() },
    ({ ticket_id, ...patch }) => updateTicket(ticket_id, patch))
  tool('list_automations', 'List automation rules with their triggers, conditions and actions.', {}, () => listAutomations().map(({ hook_token, ...a }) => a))
  tool('create_automation',
    `Create an automation rule. trigger.type is one of: ${TRIGGERS.join(', ')}. conditions are {field, op, value} (fields like message.text, chat.type, chat.labels, time.business_hours; ops contains, equals, matches, is_true, is_false...). actions are {type, ...} with types send_message{text}, ai_reply, ai_generate{prompt}, add_label{label}, assign{user_id}, create_ticket{title}, add_note{text}, http_request{url,method,body}, set_ai_mode{mode}, set_chat_status{status}, wait{seconds}. Text fields accept {{message.text}}, {{contact.name}}, {{ai.output}} variables.`,
    { name: z.string().min(1), trigger: z.object({ type: z.enum(TRIGGERS), time: z.string().optional(), days: z.array(z.number()).optional() }), conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.string().optional() })).optional(), match: z.enum(['all', 'any']).optional(), actions: z.array(z.object({ type: z.string() }).passthrough()).min(1), cooldown_minutes: z.number().optional() },
    (a) => { const { hook_token, ...auto } = saveAutomation(a); return auto })
  tool('set_automation_enabled', 'Turn an automation on or off.', { automation_id: z.string(), enabled: z.boolean() }, (a) => {
    const cur = listAutomations().find((x) => x.id === a.automation_id)
    if (!cur) throw new Error('Automation not found')
    const { hook_token, ...auto } = saveAutomation({ name: cur.name, enabled: a.enabled }, cur.id)
    return auto
  })
  return s
}

/** Stateless Streamable HTTP endpoint: one server per request, so it scales and survives restarts. */
export async function handleMcp(req: Request, res: Response) {
  const server = build()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}) })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
