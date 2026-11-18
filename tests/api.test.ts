import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { App, anthropicMock, hmac, mockServer, openAiMock, sleep, until } from './harness.ts'

const app = new App(4310)
let num: any, apiKey = ''
const mocks: { close: () => Promise<unknown> }[] = []

const simulate = (text: string, from = '15550001', name = 'Ana', group?: string) => app.ok('POST', `/numbers/${num.id}/simulate`, { from, name, text, group })
const chatByPhone = async (phone: string) => (await app.ok('GET', `/chats?q=${phone}`))[0]
const messages = (chatId: string) => app.ok('GET', `/chats/${chatId}/messages`)
const outbound = async (chatId: string) => (await messages(chatId)).filter((m: any) => m.direction === 'out')

before(async () => { await app.start() })
after(async () => { await app.stop(); for (const m of mocks) await m.close() })

test('setup, sign-in and access control', async () => {
  assert.equal((await app.req('GET', '/chats', undefined, { anon: true })).status, 401)
  assert.equal((await app.ok('GET', '/setup/status')).needs_setup, true)
  assert.equal((await app.req('POST', '/setup', { name: 'Owner', email: 'owner@test.dev', password: 'short' })).status, 400)
  const s = await app.ok('POST', '/setup', { name: 'Owner', email: 'Owner@Test.dev', password: 'password123', workspace: 'Acme' })
  assert.equal(s.user.role, 'admin')
  assert.equal((await app.req('POST', '/setup', { name: 'X', email: 'x@test.dev', password: 'password123' })).status, 409)
  assert.equal((await app.ok('GET', '/me')).workspace.name, 'Acme')
  assert.equal((await app.req('POST', '/auth/login', { email: 'owner@test.dev', password: 'wrong' }, { anon: true })).status, 401)
  await app.ok('PUT', '/settings', { sending: { minDelayMs: 0, maxDelayMs: 0, broadcastMinDelayMs: 0, broadcastMaxDelayMs: 0 } })

  // An agent can work chats but cannot reach admin settings.
  await app.ok('POST', '/users', { name: 'Agent', email: 'agent@test.dev', password: 'password123' })
  const agent = new App(app.port, app.dataDir)
  await agent.ok('POST', '/auth/login', { email: 'agent@test.dev', password: 'password123' })
  assert.equal((await agent.req('GET', '/api-keys')).status, 403)
  assert.equal((await agent.req('POST', '/numbers', { name: 'x', kind: 'sandbox' })).status, 403)
  assert.equal((await agent.req('GET', '/chats')).status, 200)
})

test('inbox: receive, reply, notes, labels, assignment', async () => {
  num = await app.ok('POST', '/numbers', { name: 'Support line', kind: 'sandbox' })
  await until(async () => (await app.ok('GET', '/numbers'))[0].status === 'connected', 'sandbox number to connect')
  await simulate('Hello there')
  const chat = await until(() => chatByPhone('15550001'), 'chat to appear')
  assert.equal(chat.name, 'Ana'); assert.equal(chat.unread, 1); assert.equal(chat.type, 'dm')

  const sent = await app.ok('POST', `/chats/${chat.id}/messages`, { text: 'Hi Ana!' })
  assert.equal(sent.status, 'pending')
  await until(async () => (await messages(chat.id)).find((m: any) => m.id === sent.id)?.status === 'delivered', 'reply to be delivered')
  assert.equal((await app.ok('GET', `/chats/${chat.id}`)).unread, 0)
  assert.equal((await app.req('POST', `/chats/${chat.id}/messages`, { text: '   ' })).status, 400)

  await app.ok('POST', `/chats/${chat.id}/notes`, { text: 'VIP customer' })
  const all = await messages(chat.id)
  assert.deepEqual(all.map((m: any) => m.direction), ['in', 'out', 'note'])

  const labelled = await app.ok('POST', `/chats/${chat.id}/labels`, { label: 'VIP' })
  assert.deepEqual(labelled.labels.map((l: any) => l.name), ['VIP'])
  assert.equal((await app.ok('GET', `/chats?label=${labelled.labels[0].id}`)).length, 1)
  assert.equal((await app.ok('DELETE', `/chats/${chat.id}/labels/VIP`)).labels.length, 0)

  const me = (await app.ok('GET', '/me')).user
  await app.ok('PATCH', `/chats/${chat.id}`, { assignee_id: me.id, status: 'closed' })
  assert.equal((await app.ok('GET', '/chats?assignee=me')).length, 1)
  await simulate('One more thing')
  await until(async () => (await app.ok('GET', `/chats/${chat.id}`)).status === 'open', 'closed chat to reopen on a new message')

  await simulate('standup at 10', '15550002', 'Bo', 'Ops Team')
  const group = await until(async () => (await app.ok('GET', '/chats?type=group'))[0], 'group chat')
  assert.equal(group.name, 'Ops Team')
  assert.equal((await messages(group.id))[0].sender_name, 'Bo')
})

test('REST API keys and outgoing webhooks', async () => {
  const hook = await mockServer(() => ({}))
  mocks.push(hook)
  const wh = await app.ok('POST', '/webhooks', { url: `${hook.url}/in`, events: ['message.received', 'message.sent'] })
  const created = await app.ok('POST', '/api-keys', { name: 'CI' })
  apiKey = created.key
  assert.match(apiKey, /^sb_/)
  assert.equal((await app.req('GET', '/chats', undefined, { key: 'sb_wrong' })).status, 401)

  const msg = await app.ok('POST', '/messages', { number_id: num.id, to: '+1 (555) 000-3', name: 'Cy', text: 'From the API' }, { key: apiKey })
  assert.equal(msg.sent_by, 'api')
  const chat = await until(() => chatByPhone('15550003'), 'API-created chat')
  assert.equal(chat.name, 'Cy')
  await simulate('reply from Cy', '15550003', 'Cy')

  const got = await until(() => hook.calls.find((c) => c.body.event === 'message.received' && c.body.data.message.text === 'reply from Cy'), 'webhook delivery')
  assert.equal(got.headers['x-switchboard-signature'], hmac(wh.secret, got.raw))
  assert.ok(hook.calls.some((c) => c.body.event === 'message.sent' && c.body.data.message.text === 'From the API'))
  await until(async () => (await app.ok('GET', `/webhooks/${wh.id}/deliveries`)).some((d: any) => d.ok === 1), 'delivery log')
  await app.ok('DELETE', `/webhooks/${wh.id}`)
})

test('automations: conditions, actions, cooldown, variables, failures', async () => {
  const crm = await mockServer(({ url }) => (url.includes('fail') ? { status: 500 } : { body: { lead_id: 'L-42' } }))
  mocks.push(crm)
  const pricing = await app.ok('POST', '/automations', {
    name: 'Pricing reply', trigger: { type: 'message.received' }, cooldown_minutes: 60,
    conditions: [{ field: 'message.text', op: 'contains', value: 'price, pricing' }, { field: 'chat.type', op: 'equals', value: 'dm' }],
    actions: [
      { type: 'http_request', url: `${crm.url}/leads`, method: 'POST', body: '{"phone":"{{contact.phone}}","q":"{{message.text}}"}' },
      { type: 'send_message', text: 'Hi {{contact.name}}, plans start at $10. Ref {{http.json.lead_id}}' },
      { type: 'add_label', label: 'Lead' }, { type: 'create_ticket', title: 'Pricing: {{message.text}}', priority: 'high' }, { type: 'assign' },
    ],
  })
  await simulate('What is the PRICE?', '15550010', 'Dee')
  const chat = await until(() => chatByPhone('15550010'), 'chat')
  const reply = await until(async () => (await outbound(chat.id))[0], 'automation reply')
  assert.equal(reply.text, 'Hi Dee, plans start at $10. Ref L-42')
  assert.equal(reply.sent_by, `automation:${pricing.id}`)
  assert.deepEqual(crm.calls[0].body, { phone: '15550010', q: 'What is the PRICE?' })
  const after = await until(async () => { const c = await app.ok('GET', `/chats/${chat.id}`); return c.assignee_id && c }, 'assignment')
  assert.deepEqual(after.labels.map((l: any) => l.name), ['Lead'])
  const tickets = await app.ok('GET', `/tickets?chat_id=${chat.id}`)
  assert.equal(tickets.length, 1); assert.equal(tickets[0].priority, 'high'); assert.equal(tickets[0].title, 'Pricing: What is the PRICE?')

  // Cooldown: a second match inside the window is ignored. Non-matching text and groups never fire.
  await simulate('price again?', '15550010', 'Dee')
  await simulate('just saying hi', '15550011', 'Eli')
  await simulate('price for the group?', '15550012', 'Fay', 'Buyers')
  await sleep(400)
  assert.equal((await outbound(chat.id)).length, 1)
  assert.equal((await app.ok('GET', `/automations/${pricing.id}/runs`)).length, 1)

  // A failing step stops the run and is recorded.
  const broken = await app.ok('POST', '/automations', { name: 'Broken', trigger: { type: 'message.received' }, conditions: [{ field: 'message.text', op: 'matches', value: '^break' }], actions: [{ type: 'http_request', url: `${crm.url}/fail` }, { type: 'send_message', text: 'never' }] })
  await simulate('break it', '15550013', 'Gus')
  const run = await until(async () => (await app.ok('GET', `/automations/${broken.id}/runs`))[0], 'failed run')
  assert.equal(run.status, 'failed'); assert.equal(run.log.length, 1); assert.equal(run.log[0].ok, false)

  // Disabled automations do nothing; validation rejects bad input.
  await app.ok('PUT', `/automations/${broken.id}`, { enabled: false })
  await simulate('break again', '15550013', 'Gus')
  await sleep(300)
  assert.equal((await app.ok('GET', `/automations/${broken.id}/runs`)).length, 1)
  assert.equal((await app.req('POST', '/automations', { name: 'x', trigger: { type: 'nope' }, actions: [{ type: 'wait' }] })).status, 400)
  assert.equal((await app.req('POST', '/automations', { name: 'x', trigger: { type: 'message.received' }, actions: [] })).status, 400)

  // Business-hours condition: with hours disabled for every day, "outside hours" is always true.
  await app.ok('PUT', '/settings', { businessHours: { enabled: true, days: [], start: '09:00', end: '18:00' } })
  await app.ok('POST', '/automations', { name: 'Away', trigger: { type: 'message.received' }, conditions: [{ field: 'time.business_hours', op: 'is_false' }, { field: 'message.text', op: 'contains', value: 'anyone' }], actions: [{ type: 'send_message', text: 'We are closed right now.' }] })
  await simulate('anyone there?', '15550014', 'Hal')
  const away = await until(() => chatByPhone('15550014'), 'chat')
  assert.equal((await until(async () => (await outbound(away.id))[0], 'away reply')).text, 'We are closed right now.')
})

test('automations: inbound webhook and ticket triggers', async () => {
  const chat = await chatByPhone('15550010')
  const hooked = await app.ok('POST', '/automations', { name: 'Order shipped', trigger: { type: 'webhook' }, actions: [{ type: 'send_message', text: 'Order {{webhook.order}} shipped!' }] })
  const r = await fetch(`${app.url}/api/v1/hooks/${hooked.id}/${hooked.hook_token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat.id, order: 'A-77' }) })
  assert.equal(r.status, 200)
  await until(async () => (await outbound(chat.id)).some((m: any) => m.text === 'Order A-77 shipped!'), 'webhook-triggered message')
  assert.equal((await fetch(`${app.url}/api/v1/hooks/${hooked.id}/wrong`, { method: 'POST' })).status, 404)

  await app.ok('POST', '/automations', { name: 'Ticket resolved', trigger: { type: 'ticket.updated' }, conditions: [{ field: 'ticket.status', op: 'equals', value: 'resolved' }], actions: [{ type: 'send_message', text: 'Ticket #{{ticket.seq}} is resolved.' }] })
  const t = (await app.ok('GET', `/tickets?chat_id=${chat.id}`))[0]
  await app.ok('PATCH', `/tickets/${t.id}`, { status: 'in_progress' })
  await app.ok('PATCH', `/tickets/${t.id}`, { status: 'resolved' })
  await until(async () => (await outbound(chat.id)).some((m: any) => m.text === `Ticket #${t.seq} is resolved.`), 'ticket automation')
  assert.equal((await outbound(chat.id)).filter((m: any) => /is resolved/.test(m.text)).length, 1)
})

test('knowledge hub: add, search, import, update, delete', async () => {
  const site = await mockServer(() => ({ type: 'text/html', body: '<html><head><title>Shipping policy</title><script>ignore()</script></head><body><h1>Shipping</h1><p>Orders ship within 2 business days via DHL.</p></body></html>' }))
  mocks.push(site)
  const refund = await app.ok('POST', '/knowledge', { title: 'Refund policy', content: 'Refunds are available within 30 days of purchase.\n\nContact billing to start a refund.' })
  await app.ok('POST', '/knowledge', { title: 'Opening hours', content: 'We are open Monday to Friday, 9am to 6pm.' })
  const imported = await app.ok('POST', '/knowledge', { url: `${site.url}/shipping` })
  assert.equal(imported.title, 'Shipping policy'); assert.ok(!imported.content.includes('ignore()'))
  assert.equal((await app.ok('GET', '/knowledge/search?q=how do refunds work'))[0].title, 'Refund policy')
  assert.equal((await app.ok('GET', '/knowledge/search?q=when do orders ship'))[0].title, 'Shipping policy')
  assert.deepEqual(await app.ok('GET', '/knowledge/search?q=!!! ???'), [])
  await app.ok('PUT', `/knowledge/${refund.id}`, { content: 'All sales are final.' })
  assert.ok(!(await app.ok('GET', '/knowledge/search?q=refunds 30 days')).some((h: any) => h.body.includes('30 days')))
  await app.ok('DELETE', `/knowledge/${imported.id}`)
  assert.equal((await app.ok('GET', '/knowledge/search?q=DHL')).length, 0)
  assert.equal((await app.req('POST', '/knowledge', { url: `${site.url.replace(/\d+$/, '1')}/down` })).status, 400)
})

test('AI agent (OpenAI-compatible): knowledge answers, auto-reply, handoff, MCP tools, automations', async () => {
  const llm = await openAiMock()
  mocks.push(llm)
  assert.equal((await app.req('POST', '/ai/test', { message: 'hi' })).status, 400) // not configured yet
  const saved = await app.ok('PUT', '/ai/settings', { provider: 'openai', apiKey: 'sk-test-secret-123456', baseUrl: `${llm.url}/v1`, model: 'mock' })
  assert.ok(!JSON.stringify(saved).includes('sk-test-secret-123456'), 'API key must never be returned in full')
  await app.ok('PUT', '/ai/settings', { agentName: 'Robo', apiKey: saved.apiKey }) // masked key round-trip keeps the real one
  assert.equal(llm.calls.length, 0)

  await app.ok('PATCH', `/numbers/${num.id}`, { ai_enabled: true })
  await simulate('what are your opening hours', '15550020', 'Ivy')
  const chat = await until(() => chatByPhone('15550020'), 'chat')
  const reply = await until(async () => (await outbound(chat.id))[0], 'AI reply')
  assert.match(reply.text, /^ANSWER: .*Monday to Friday/); assert.equal(reply.sent_by, 'ai')
  assert.equal(llm.calls[0].headers.authorization, 'Bearer sk-test-secret-123456')

  // Asking for a person hands the chat off: label, assignment, note, and the agent goes quiet.
  await simulate('I want a human please', '15550020', 'Ivy')
  const handed = await until(async () => { const c = await app.ok('GET', `/chats/${chat.id}`); return c.ai_mode === 'off' && c }, 'handoff')
  assert.ok(handed.labels.some((l: any) => l.name === 'Needs human')); assert.ok(handed.assignee_id)
  await until(async () => (await outbound(chat.id)).length === 2, 'handoff message')
  assert.ok((await messages(chat.id)).some((m: any) => m.direction === 'note' && /handed off/.test(m.text)))
  const before = llm.calls.length
  await simulate('hello??', '15550020', 'Ivy')
  await sleep(400)
  assert.equal(llm.calls.length, before, 'agent must stay silent after handoff'); assert.equal((await outbound(chat.id)).length, 2)

  // Groups are ignored unless enabled; drafts never send anything.
  await simulate('opening hours?', '15550021', 'Jo', 'Ops Team')
  await sleep(300)
  assert.equal(llm.calls.length, before)
  const draft = await app.ok('POST', `/chats/${chat.id}/ai/draft`, {})
  assert.match(draft.text, /^ANSWER/); assert.equal((await outbound(chat.id)).length, 2)

  // External MCP server tools are offered to the agent (here: this app's own MCP endpoint).
  const srv = await app.ok('POST', '/mcp-servers', { name: 'Self', url: `${app.url}/mcp`, headers: { Authorization: `Bearer ${apiKey}` } })
  const probe = await app.ok('POST', `/mcp-servers/${srv.id}/test`, {})
  assert.equal(probe.ok, true); assert.ok(probe.tools.some((t: any) => t.name === 'send_message'))
  await simulate('who is on the team', '15550022', 'Kai')
  const kai = await until(() => chatByPhone('15550022'), 'chat')
  assert.match((await until(async () => (await outbound(kai.id))[0], 'MCP-backed reply')).text, /agent@test\.dev/)
  await app.ok('DELETE', `/mcp-servers/${srv.id}`)

  // An automation that replied suppresses the default agent reply; ai_generate feeds later steps.
  await app.ok('POST', '/automations', { name: 'Classify', trigger: { type: 'message.received' }, conditions: [{ field: 'message.text', op: 'starts_with', value: 'classify' }], actions: [{ type: 'ai_generate', prompt: 'One word topic for: {{message.text}}' }, { type: 'add_note', text: 'Topic => {{ai.output}}' }, { type: 'send_message', text: 'Noted.' }] })
  await simulate('classify my invoice problem', '15550023', 'Lu')
  const lu = await until(() => chatByPhone('15550023'), 'chat')
  await until(async () => (await messages(lu.id)).some((m: any) => m.direction === 'note' && /^Topic => GEN: [\s\S]*invoice problem/.test(m.text)), 'ai_generate output in note')
  await sleep(300)
  assert.deepEqual((await outbound(lu.id)).map((m: any) => m.text), ['Noted.'])
  await app.ok('PATCH', `/numbers/${num.id}`, { ai_enabled: false })
})

test('AI agent (Claude via the Anthropic SDK)', async () => {
  const claude = await anthropicMock()
  mocks.push(claude)
  await app.ok('PUT', '/ai/settings', { provider: 'anthropic', apiKey: 'sk-ant-test-abcdef', baseUrl: claude.url, model: 'claude-opus-5-5' })
  await simulate('are you open on monday?', '15550030', 'Mo')
  const chat = await until(() => chatByPhone('15550030'), 'chat')
  await sleep(200)
  assert.equal((await outbound(chat.id)).length, 0, 'agent is off for this number')
  await app.ok('PATCH', `/chats/${chat.id}`, { ai_mode: 'on' }) // per-chat override
  await simulate('hello? opening hours?', '15550030', 'Mo')
  const reply = await until(async () => (await outbound(chat.id))[0], 'Claude reply')
  assert.match(reply.text, /^CLAUDE: .*Monday to Friday/)
  const first = claude.calls[0]
  assert.ok([first.headers['x-api-key'], first.headers.authorization].some((h) => String(h).includes('sk-ant-test-abcdef')), 'key is sent to the provider'); assert.equal(first.body.model, 'claude-opus-5-5')
  assert.ok(first.body.tools.some((t: any) => t.name === 'handoff_to_human' && t.input_schema))
  const second = claude.calls[1].body.messages
  assert.equal(second.at(-1).content[0].type, 'tool_result'); assert.equal(second.at(-2).content[0].type, 'tool_use')
  assert.match((await app.ok('POST', `/chats/${chat.id}/ai/summary`, {})).text, /^CLAUDE-GEN/)
  assert.match((await app.ok('POST', '/ai/test', { message: 'refund?' })).text, /^CLAUDE-GEN/)
})

test('MCP server: auth, tools, and actions over Streamable HTTP', async () => {
  const denied = await fetch(`${app.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  assert.equal(denied.status, 401)
  const client = new Client({ name: 'qa-bot', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp?key=${apiKey}`)))
  const call = async (name: string, args: any = {}) => {
    const r: any = await client.callTool({ name, arguments: args })
    if (r.isError) throw new Error(r.content[0].text)
    return JSON.parse(r.content[0].text)
  }
  const names = (await client.listTools()).tools.map((t) => t.name)
  for (const n of ['list_chats', 'get_chat_messages', 'send_message', 'search_knowledge', 'add_knowledge', 'create_ticket', 'create_automation', 'list_numbers']) assert.ok(names.includes(n), `missing tool ${n}`)

  const chats = await call('list_chats', { query: '15550001' })
  assert.equal(chats.length, 1)
  await call('send_message', { chat_id: chats[0].id, text: 'Sent by an MCP agent' })
  await until(async () => (await call('get_chat_messages', { chat_id: chats[0].id })).some((m: any) => m.text === 'Sent by an MCP agent' && m.status === 'delivered'), 'MCP message delivered')
  const fresh = await call('send_message', { number_id: num.id, phone: '15550040', text: 'New contact via MCP' })
  assert.equal(fresh.direction, 'out')
  await call('add_knowledge', { title: 'Parking', content: 'Free parking is available behind the building.' })
  assert.equal((await call('search_knowledge', { query: 'parking' }))[0].title, 'Parking')
  const ticket = await call('create_ticket', { title: 'From MCP', chat_id: chats[0].id, priority: 'urgent' })
  assert.equal((await call('update_ticket', { ticket_id: ticket.id, status: 'resolved' })).status, 'resolved')
  const auto = await call('create_automation', { name: 'MCP made', trigger: { type: 'message.received' }, conditions: [{ field: 'message.text', op: 'equals', value: 'ping' }], actions: [{ type: 'send_message', text: 'pong' }] })
  assert.ok(!('hook_token' in auto))
  await simulate('ping', '15550041', 'Nia')
  const nia = await until(() => chatByPhone('15550041'), 'chat')
  assert.equal((await until(async () => (await outbound(nia.id))[0], 'pong')).text, 'pong')
  await assert.rejects(call('send_message', { text: 'no target' }), /chat_id/)
  await client.close()
})

test('scheduled messages, broadcasts and the daily limit', async () => {
  const a = await chatByPhone('15550001'), b = await chatByPhone('15550003'), c = await chatByPhone('15550010')
  await app.ok('PUT', '/settings', { sending: { broadcastDailyLimit: 2 } })
  const s = await app.ok('POST', '/scheduled', { name: 'Promo', chat_ids: [a.id, b.id, c.id, 'cht_missing'], text: 'Big news!' })
  assert.equal(s.chat_ids.length, 3)
  await until(async () => (await app.ok('GET', '/scheduled')).find((x: any) => x.id === s.id)?.status === 'sent', 'broadcast to run')
  const results = await until(async () => {
    const all = await Promise.all([a, b, c].map(async (ch) => (await outbound(ch.id)).find((m: any) => m.text === 'Big news!')))
    return all.every((m) => m && m.status !== 'pending') && all
  }, 'broadcast messages to settle')
  assert.equal(results.filter((m: any) => m.status === 'failed').length, 1, 'third recipient exceeds the daily limit')
  assert.match(results.find((m: any) => m.status === 'failed').error, /Daily broadcast limit/)
  assert.equal((await app.req('POST', '/scheduled', { chat_ids: [], text: 'x' })).status, 400)

  const later = await app.ok('POST', '/scheduled', { chat_ids: [a.id], text: 'Later', send_at: new Date(Date.now() + 3600_000).toISOString(), repeat: 'daily' })
  await sleep(500)
  assert.equal((await app.ok('GET', '/scheduled')).find((x: any) => x.id === later.id).status, 'pending')
  assert.ok(!(await outbound(a.id)).some((m: any) => m.text === 'Later'))
})

test('analytics, quick replies and team management', async () => {
  const stats = await app.ok('GET', '/analytics')
  assert.ok(stats.messages_in > 10 && stats.messages_out > 5); assert.equal(stats.by_day.length, 7); assert.ok(stats.by_sender.some((s: any) => s.name === 'AI agent'))
  assert.equal(typeof stats.median_response_seconds, 'number')
  await app.ok('POST', '/quick-replies', { shortcut: '/Thanks', text: 'Thank you for reaching out!' })
  assert.equal((await app.ok('GET', '/quick-replies'))[0].shortcut, 'thanks')
  assert.equal((await app.req('POST', '/quick-replies', { shortcut: 'thanks', text: 'dup' })).status, 400)
  const me = (await app.ok('GET', '/me')).user
  assert.equal((await app.req('PATCH', `/users/${me.id}`, { role: 'agent' })).status, 400, 'last admin cannot be demoted')
  assert.equal((await app.req('DELETE', `/users/${me.id}`)).status, 400)
})

test('data survives a restart', async () => {
  const before = (await app.ok('GET', '/chats')).length
  await app.stop(); await app.start()
  assert.equal((await app.ok('GET', '/chats')).length, before)
  await until(async () => (await app.ok('GET', '/numbers'))[0].status === 'connected', 'number to reconnect after restart')
  await simulate('still there?', '15550001')
  const chat = await chatByPhone('15550001')
  await until(async () => (await messages(chat.id)).at(-1).text === 'still there?', 'message after restart')
  assert.equal((await app.req('GET', '/chats', undefined, { key: apiKey })).status, 200)
})
