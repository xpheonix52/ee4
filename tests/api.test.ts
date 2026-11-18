import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { App, anthropicMock, hmac, mockServer, openAiMock, sleep, until } from './harness.ts'

const app = new App(4310)
let num: any, apiKey = '', llmRef: any
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
  llmRef = llm
  const saved = await app.ok('PUT', '/ai/settings', { provider: 'openai', apiKey: 'sk-test-secret-123456', baseUrl: `${llm.url}/v1`, model: 'mock', responseDelaySeconds: 0, snoozeSeconds: 0 })
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

test('training the agent: persona, FAQs, custom tools, activation, self-training, assistant', async () => {
  const llm = llmRef
  const systemOf = () => llm.calls.at(-1).body.messages[0].content as string
  const ask = async (text: string, phone: string, name = 'Tess') => {
    await simulate(text, phone, name)
    const chat = await until(() => chatByPhone(phone), 'chat')
    if (chat.ai_mode !== 'on') await app.ok('PATCH', `/chats/${chat.id}`, { ai_mode: 'on' })
    return chat
  }
  const logs = () => app.ok('GET', '/ai/logs')

  // Setup help: a wrong model or key is explained in plain words, with models to pick from.
  assert.deepEqual((await app.ok('GET', '/ai/models')).models, ['mock', 'vendor/haiku-9', 'vendor/sonnet-8', 'vendor/sonnet-9'])
  assert.equal((await app.ok('POST', '/ai/check', {})).ok, true)
  await app.ok('PUT', '/ai/settings', { model: ' sonnet ' })
  const wrongModel = await app.ok('POST', '/ai/check', {})
  assert.equal(wrongModel.ok, false); assert.match(wrongModel.error, /does not have a model called "sonnet"/); assert.deepEqual(wrongModel.suggestions, ['vendor/sonnet-9', 'vendor/sonnet-8'])
  await app.ok('PUT', '/ai/settings', { model: 'denied' })
  assert.match((await app.ok('POST', '/ai/check', {})).error, /rejected the API key/)
  // The key's prefix decides where requests go, whatever the form was left on.
  const or = await app.ok('PUT', '/ai/settings', { provider: 'anthropic', baseUrl: '', apiKey: 'sk-or-v1-0123456789abcdef' })
  assert.equal(or.provider, 'openai'); assert.equal(or.baseUrl, 'https://openrouter.ai/api/v1'); assert.equal(or.provider_name, 'OpenRouter')
  const ant = await app.ok('PUT', '/ai/settings', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-ant-0123456789abcdef' })
  assert.equal(ant.provider, 'anthropic'); assert.equal(ant.baseUrl, '')
  await app.ok('PUT', '/ai/settings', { provider: 'openai', apiKey: 'sk-test-secret-123456', baseUrl: `${llm.url}/v1`, model: 'mock' })

  // Persona: personality preset, restrictions and contact properties all reach the model.
  await app.ok('PUT', '/ai/settings', { personality: 'spartan', restrictions: 'Never discuss refunds.' })
  const tess = await ask('hello', '15550070')
  await app.ok('PATCH', `/chats/${tess.id}`, { props: { plan: 'gold', empty: '' } })
  await simulate('what are your opening hours', '15550070', 'Tess')
  await until(async () => (await outbound(tess.id)).length >= 1, 'reply')
  assert.match(systemOf(), /ultra-brief/); assert.match(systemOf(), /Hard restrictions[\s\S]*Never discuss refunds\./); assert.match(systemOf(), /plan = gold/)
  assert.deepEqual((await app.ok('GET', `/chats/${tess.id}`)).props, { plan: 'gold' })

  // FAQs: variations and handling instructions are searchable; entries awaiting review are not.
  const faq = await app.ok('POST', '/faqs', { questions: ['Do you ship to Canada?', 'canada delivery'], answer: 'Yes, in 5 days.', instructions: 'Offer express shipping.' })
  const hit = (await app.ok('GET', '/knowledge/search?q=canada delivery'))[0]
  assert.match(hit.body, /Yes, in 5 days\./); assert.match(hit.body, /Offer express shipping/)
  const pending = await app.ok('POST', '/faqs', { questions: 'Do you sell gift cards?', answer: 'Yes, from $10.', status: 'review' })
  assert.equal((await app.ok('GET', '/knowledge/search?q=gift cards')).length, 0)
  await app.ok('PUT', `/faqs/${pending.id}`, { status: 'active' })
  assert.equal((await app.ok('GET', '/knowledge/search?q=gift cards')).length, 1)
  assert.equal((await app.req('POST', '/faqs', { questions: [], answer: 'x' })).status, 400)
  await app.ok('DELETE', `/faqs/${faq.id}`)
  assert.equal((await app.ok('GET', '/knowledge/search?q=canada')).length, 0)

  // Custom tool: the agent calls our HTTP API with a path parameter and a secret that is never echoed back.
  const shop = await mockServer(() => ({ body: { status: 'shipped', eta: 'Friday' } }))
  mocks.push(shop)
  const tool = await app.ok('POST', '/ai/tools', { name: 'Order Status', description: 'Look up an order by id', method: 'GET', url: `${shop.url}/orders/{order_id}`, auth: { type: 'bearer', token: 'tok-secret' }, params: [{ name: 'order_id', type: 'string', location: 'path', required: true, description: 'The order id' }] })
  assert.equal(tool.name, 'order_status'); assert.ok(!JSON.stringify(await app.ok('GET', '/ai/tools')).includes('tok-secret'))
  await simulate('where is order AB-123', '15550070', 'Tess')
  await until(async () => (await outbound(tess.id)).some((m: any) => /shipped/.test(m.text)), 'tool-backed reply')
  assert.equal(shop.calls[0].url, '/orders/AB-123'); assert.equal(shop.calls[0].headers.authorization, 'Bearer tok-secret')
  assert.ok((await logs()).some((l: any) => l.kind === 'reply' && l.trace.some((t: any) => t.tool === 'order_status')))
  await app.ok('PUT', `/ai/tools/${tool.id}`, { enabled: false })

  // Activation rules: a message the rules exclude gets no reply.
  await app.ok('PUT', '/ai/settings', { activationRules: 'Do NOT activate for simple acknowledgments.' })
  let count = (await outbound(tess.id)).length
  await simulate('ok thanks', '15550070', 'Tess')
  await until(async () => (await logs())[0].kind === 'skipped' && /Activation rules/.test((await logs())[0].output), 'skip logged')
  assert.equal((await outbound(tess.id)).length, count)
  await app.ok('PUT', '/ai/settings', { activationRules: '' })

  // Response delay: a teammate who answers inside the window makes the agent stand down, then it snoozes.
  await app.ok('PUT', '/ai/settings', { responseDelaySeconds: 1, snoozeSeconds: 60 })
  await simulate('are you there?', '15550070', 'Tess')
  await app.ok('POST', `/chats/${tess.id}/messages`, { text: 'A human here, I will take this.' })
  await until(async () => /stood down/.test((await logs())[0].output), 'stand down', 4000)
  await simulate('great, and the hours?', '15550070', 'Tess')
  await sleep(1500)
  assert.equal((await outbound(tess.id)).filter((m: any) => m.sent_by === 'ai').length, count, 'no AI message during delay or snooze')
  await app.ok('PUT', '/ai/settings', { responseDelaySeconds: 0, snoozeSeconds: 0 })
  await app.ok('PATCH', `/chats/${tess.id}`, { ai_snooze_until: 0 })

  // Passive mode: the agent drafts into a private note instead of sending. Internal contacts are ignored.
  await app.ok('PUT', '/ai/settings', { allowSend: false })
  await simulate('opening hours please', '15550070', 'Tess')
  await until(async () => (await messages(tess.id)).some((m: any) => m.direction === 'note' && /^Suggested reply/.test(m.text)), 'suggestion note')
  await app.ok('PUT', '/ai/settings', { allowSend: true })
  await app.ok('PATCH', `/chats/${tess.id}`, { internal: true })
  count = llm.calls.length
  await simulate('internal chatter about hours', '15550070', 'Tess')
  await sleep(300)
  assert.equal(llm.calls.length, count)

  // Self-training: a teammate's answer becomes a draft FAQ that needs approval; rerunning learns nothing new.
  await simulate('Do you deliver on weekends?', '15550071', 'Uma')
  const uma = await until(() => chatByPhone('15550071'), 'chat')
  await app.ok('POST', `/chats/${uma.id}/messages`, { text: 'Yes, we deliver on Saturdays.' })
  const run = await app.ok('POST', '/ai/training/run', {})
  assert.equal(run.status, 'complete'); assert.equal(run.learned, 1)
  const learned = (await app.ok('GET', '/faqs')).find((f: any) => f.source === 'learned')
  assert.equal(learned.status, 'review'); assert.deepEqual(learned.questions, ['Do you deliver on weekends?'])
  assert.equal((await app.ok('GET', '/knowledge/search?q=deliver weekends saturdays')).filter((h: any) => h.doc_id === learned.id).length, 0)
  assert.equal((await app.ok('POST', '/ai/training/run', {})).learned, 0)
  assert.equal((await app.ok('GET', '/ai/training')).length, 2)

  // AI flagging: the model decides which messages the team must not miss.
  await app.ok('PUT', '/settings', { flagging: { mode: 'ai', rules: 'Never flag thanks.' } })
  await simulate('thanks a lot', '15550072', 'Wes')
  await simulate('my parcel never arrived', '15550072', 'Wes')
  const wes = await until(() => chatByPhone('15550072'), 'chat')
  await until(async () => (await messages(wes.id)).some((m: any) => m.text === 'my parcel never arrived' && m.flagged), 'AI flag')
  assert.equal((await messages(wes.id)).find((m: any) => m.text === 'thanks a lot').flagged, false)
  await app.ok('PUT', '/settings', { flagging: { mode: 'smart', rules: '' } })

  // Workspace assistant uses the same tools as the MCP server.
  const a = await app.ok('POST', '/assistant', { messages: [{ role: 'user', text: 'who is on the team?' }] })
  assert.match(a.text, /agent@test\.dev/); assert.equal(a.steps[0].tool, 'list_team')

  // Emoji ticketing: a teammate reacts to a customer message and a ticket is raised from it.
  await app.ok('POST', '/automations', { name: 'Emoji ticket', trigger: { type: 'message.reaction' }, conditions: [{ field: 'reaction.emoji', op: 'equals', value: '🎫' }, { field: 'reaction.from_team', op: 'is_true' }], actions: [{ type: 'create_ticket', title: '{{message.text}}' }, { type: 'set_property', key: 'last_ticket', value: '#{{ticket.seq}}' }] })
  const target = (await messages(uma.id)).find((m: any) => m.direction === 'in')
  await app.ok('POST', `/numbers/${num.id}/simulate-reaction`, { message_id: target.id, emoji: '👍', from_team: true })
  await app.ok('POST', `/numbers/${num.id}/simulate-reaction`, { message_id: target.id, emoji: '🎫', from_team: true })
  const t = await until(async () => (await app.ok('GET', `/tickets?chat_id=${uma.id}`))[0], 'ticket from reaction')
  assert.equal(t.title, 'Do you deliver on weekends?'); assert.equal(t.message_id, target.id)
  await until(async () => (await app.ok('GET', `/chats/${uma.id}`)).props.last_ticket === `#${t.seq}`, 'property set by automation')
  assert.equal((await app.ok('GET', `/tickets?chat_id=${uma.id}`)).length, 1)

  // Needs-reply filter, exports, PDF knowledge.
  await simulate('one more question', '15550071', 'Uma')
  await until(async () => (await app.ok('GET', '/chats?needs_reply=true')).some((c: any) => c.id === uma.id), 'needs reply')
  assert.ok(!(await app.ok('GET', '/chats?needs_reply=true')).some((c: any) => c.id === tess.id), 'internal chats are not waiting on us')
  const csv = await app.ok('GET', '/export/tickets.csv')
  assert.match(csv.split('\n')[0], /^number,title/); assert.match(csv, /Do you deliver on weekends\?/)
  assert.equal((await app.req('GET', '/export/nope.csv')).status, 404)
  const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 53>>stream\nBT /F1 18 Tf 20 100 Td (Warranty lasts two years) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n`
  const fd = new FormData()
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'Warranty.pdf')
  const up = await fetch(`${app.url}/api/v1/knowledge/upload`, { method: 'POST', headers: { cookie: app.cookie }, body: fd })
  assert.equal(up.status, 200, await up.clone().text())
  assert.equal((await app.ok('GET', '/knowledge/search?q=warranty'))[0].title, 'Warranty')
  await app.ok('PUT', '/ai/settings', { personality: 'friendly', restrictions: '' })
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
  assert.match((await app.ok('POST', '/ai/test', { message: 'refund?' })).text, /^CLAUDE: /)
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

test('safety: uploaded files, key placement, stale backlog, login throttling', async () => {
  const chat = await chatByPhone('15550001')
  const fd = new FormData()
  fd.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'evil.html')
  const up = await fetch(`${app.url}/api/v1/chats/${chat.id}/messages`, { method: 'POST', headers: { cookie: app.cookie }, body: fd })
  const sent = await up.json()
  assert.equal(sent.type, 'document')
  const media = await fetch(app.url + sent.media_url, { headers: { cookie: app.cookie } })
  assert.equal(media.headers.get('content-type'), 'application/octet-stream', 'HTML from a chat must never render on our origin')
  assert.match(media.headers.get('content-disposition')!, /^attachment/); assert.equal(media.headers.get('x-content-type-options'), 'nosniff')
  assert.equal((await fetch(app.url + sent.media_url)).status, 401)

  const png = new FormData()
  png.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'pic.png'); png.append('text', 'see photo')
  const img = await (await fetch(`${app.url}/api/v1/chats/${chat.id}/messages`, { method: 'POST', headers: { cookie: app.cookie }, body: png })).json()
  assert.equal(img.type, 'image'); assert.equal(img.text, 'see photo')
  assert.equal((await fetch(app.url + img.media_url, { headers: { cookie: app.cookie } })).headers.get('content-type'), 'image/png')

  // API keys are accepted in the URL only on the MCP endpoint, never on the REST API.
  assert.equal((await fetch(`${app.url}/api/v1/chats?key=${apiKey}`)).status, 401)

  // A message that arrives hours late (after downtime) is stored and counted, but not auto-answered.
  await app.ok('POST', '/automations', { name: 'Echo', trigger: { type: 'message.received' }, conditions: [{ field: 'message.text', op: 'starts_with', value: 'echo' }], actions: [{ type: 'send_message', text: 'echoed' }] })
  await app.ok('POST', `/numbers/${num.id}/simulate`, { from: '15550050', name: 'Old', text: 'echo from yesterday', timestamp: Date.now() - 3600_000 })
  const old = await until(() => chatByPhone('15550050'), 'backlog chat')
  await sleep(300)
  assert.equal(old.unread, 1); assert.equal((await outbound(old.id)).length, 0)
  await simulate('echo now', '15550050', 'Old')
  await until(async () => (await outbound(old.id)).length === 1, 'fresh message is answered')

  for (let i = 0; i < 10; i++) assert.equal((await app.req('POST', '/auth/login', { email: 'agent@test.dev', password: 'nope' }, { anon: true })).status, 401)
  assert.equal((await app.req('POST', '/auth/login', { email: 'agent@test.dev', password: 'password123' }, { anon: true })).status, 429)
})

test('robustness: cooldown bursts, bot loops, broken rules, renamed chats', async () => {
  // Three messages in the same instant must still produce exactly one cooldown-limited reply.
  const burst = await app.ok('POST', '/automations', { name: 'Burst', trigger: { type: 'message.received' }, cooldown_minutes: 30, conditions: [{ field: 'message.text', op: 'starts_with', value: 'burst' }], actions: [{ type: 'send_message', text: 'one reply only' }] })
  await Promise.all([1, 2, 3].map((i) => simulate(`burst ${i}`, '15550060', 'Pat')))
  await sleep(600)
  assert.equal((await app.ok('GET', `/automations/${burst.id}/runs`)).length, 1)

  // A chatty bot on the other side cannot make us reply forever.
  for (let i = 0; i < 12; i++) await simulate('ping', '15550061', 'Bot')
  const bot = await until(() => chatByPhone('15550061'), 'chat')
  await sleep(1200)
  assert.equal((await outbound(bot.id)).filter((m: any) => m.text === 'pong').length, 8, 'auto-replies stop after 8 in a row')

  // Malformed rules are rejected up front, so they can never take the other automations down.
  assert.equal((await app.req('POST', '/automations', { name: 'bad', trigger: { type: 'message.received' }, conditions: [null], actions: [{ type: 'wait' }] })).status, 400)
  assert.equal((await app.req('POST', '/automations', { name: 'bad', trigger: { type: 'message.received' }, actions: [{}] })).status, 400)

  // A name typed by the team survives the customer's next message.
  const pat = await chatByPhone('15550060')
  await app.ok('PATCH', `/chats/${pat.id}`, { name: 'Pat (VIP, Acme)' })
  await simulate('hello again', '15550060', 'Pat')
  await until(async () => (await messages(pat.id)).at(-1).text === 'hello again', 'message')
  assert.equal((await app.ok('GET', `/chats/${pat.id}`)).name, 'Pat (VIP, Acme)')
})

test('monitoring: unanswered chats, quiet customers, follow-up reminders, message search', async () => {
  // A new workspace starts with monitoring in place; only the rule that never messages customers is on.
  const starters = (await app.ok('GET', '/automations')).filter((a: any) => /^(Flag chats waiting|Follow up when|Away message|Close chats after)/.test(a.name))
  assert.equal(starters.length, 4); assert.deepEqual(starters.filter((a: any) => a.enabled).map((a: any) => a.name), ['Flag chats waiting over 30 minutes'])
  assert.equal((await app.req('POST', '/automations', { name: 'x', trigger: { type: 'chat.waiting' }, actions: [{ type: 'add_note', text: 'x' }] })).status, 400)

  // Customer waiting with no answer: fires once, not on every scheduler pass.
  const sla = await app.ok('POST', '/automations', { name: 'SLA', trigger: { type: 'chat.waiting', minutes: 0.005 }, conditions: [{ field: 'message.text', op: 'contains', value: 'sla-check' }], actions: [{ type: 'add_label', label: 'Overdue' }, { type: 'add_note', text: 'Waiting: {{message.text}}' }] })
  await simulate('sla-check please help', '15550080', 'Vic')
  const vic = await until(() => chatByPhone('15550080'), 'chat')
  await until(async () => (await app.ok('GET', `/chats/${vic.id}`)).labels.some((l: any) => l.name === 'Overdue'), 'waiting trigger')
  await sleep(800)
  assert.equal((await app.ok('GET', `/automations/${sla.id}/runs`)).length, 1)
  await app.ok('PUT', `/automations/${sla.id}`, { enabled: false })

  // We answered and the customer went quiet: one follow-up, which does not trigger itself again.
  const quiet = await app.ok('POST', '/automations', { name: 'Nudge', trigger: { type: 'chat.quiet', hours: 0.0001 }, conditions: [{ field: 'contact.phone', op: 'equals', value: '15550080' }], actions: [{ type: 'send_message', text: 'Just checking in, {{contact.name}}.' }] })
  await app.ok('POST', `/chats/${vic.id}/messages`, { text: 'Fixed it for you.' })
  await until(async () => (await outbound(vic.id)).some((m: any) => m.text === 'Just checking in, Vic.'), 'quiet trigger')
  await sleep(1200)
  assert.equal((await outbound(vic.id)).filter((m: any) => /checking in/.test(m.text)).length, 1)
  await app.ok('PUT', `/automations/${quiet.id}`, { enabled: false })

  // Follow-up reminder: when it is due, the chat comes back with a note and an unread mark.
  await app.ok('POST', `/chats/${vic.id}/read`)
  const set = await app.ok('PATCH', `/chats/${vic.id}`, { follow_up_at: new Date(Date.now() + 400).toISOString(), follow_up_note: 'Send the quote' })
  assert.ok(set.follow_up_at > Date.now())
  assert.deepEqual((await app.ok('GET', '/chats?follow_up=true')).map((c: any) => c.id), [vic.id])
  await until(async () => (await messages(vic.id)).some((m: any) => m.direction === 'note' && m.text === 'Follow-up reminder: Send the quote'), 'reminder note')
  assert.equal((await app.ok('GET', `/chats/${vic.id}`)).unread, 1)
  await sleep(500)
  assert.equal((await messages(vic.id)).filter((m: any) => /Follow-up reminder/.test(m.text)).length, 1)
  assert.equal((await app.ok('PATCH', `/chats/${vic.id}`, { follow_up_at: null })).follow_up_at, null)
  assert.equal((await app.ok('GET', '/chats?follow_up=true')).length, 0)

  // Flagging: questions and problems are flagged, pleasantries are not, and a reply clears them.
  await simulate('ok great', '15550081', 'Xan')
  await simulate('Can you send me the invoice?', '15550081', 'Xan')
  const xan = await until(() => chatByPhone('15550081'), 'chat')
  await until(async () => (await app.ok('GET', `/chats/${xan.id}`)).flagged === 1, 'smart flag')
  assert.deepEqual((await messages(xan.id)).map((m: any) => m.flagged), [false, true])
  assert.ok((await app.ok('GET', '/chats?flagged=true')).some((c: any) => c.id === xan.id))
  await app.ok('POST', `/chats/${xan.id}/messages`, { text: 'Sent!' })
  await until(async () => (await app.ok('GET', `/chats/${xan.id}`)).flagged === 0, 'reply clears flags')
  const first = (await messages(xan.id))[0]
  assert.equal((await app.ok('POST', `/messages/${first.id}/flag`, {})).flagged, true)
  await app.ok('POST', '/tickets', { chat_id: xan.id, message_id: first.id, title: 'From flagged' })
  assert.equal((await messages(xan.id))[0].flagged, false, 'raising a ticket from a message unflags it')

  // Mentions: a note that @names me shows the chat under my mentions.
  await app.ok('POST', `/chats/${xan.id}/notes`, { text: '@Owner can you approve this discount?' })
  assert.deepEqual((await app.ok('GET', '/chats?mentions=me')).map((c: any) => c.id), [xan.id])

  // Bulk messages can address each person by name.
  await app.ok('POST', '/scheduled', { chat_ids: [xan.id], text: 'Hi {{contact.name}}, our new catalogue is out.' })
  await until(async () => (await outbound(xan.id)).some((m: any) => m.text === 'Hi Xan, our new catalogue is out.'), 'personalised broadcast')

  // Team and ticket analytics, and the audit trail.
  const stats = await app.ok('GET', '/analytics?days=30')
  assert.equal(stats.by_day.length, 30)
  const owner = stats.team.find((t: any) => t.name === 'Owner')
  assert.ok(owner.sent > 3 && owner.chats > 1 && typeof owner.avg_response_seconds === 'number')
  assert.equal(stats.tickets.total, stats.tickets.open + stats.tickets.in_progress + stats.tickets.resolved)
  await app.ok('POST', '/labels', { name: 'From API' }, { key: apiKey })
  const audit = await app.ok('GET', '/audit')
  assert.ok(audit.some((a: any) => a.action === 'Added automations' && a.detail === 'SLA' && a.actor === 'Owner'))
  assert.ok(audit.some((a: any) => /^API key: /.test(a.actor)), 'API activity is attributed to its key')
  assert.ok(!audit.some((a: any) => /chats|messages/.test(a.action)), 'chat traffic stays out of the audit trail')

  // Search looks inside message history, not just names.
  assert.deepEqual((await app.ok('GET', '/chats?q=Fixed it for you')).map((c: any) => c.id), [vic.id])
})

test('data survives a restart', async () => {
  // A slow broadcast must not hold up a teammate's reply, and whatever is unsent at shutdown is flagged, not lost silently.
  const [x, y] = [await chatByPhone('15550020'), await chatByPhone('15550030')]
  await app.ok('PUT', '/settings', { sending: { broadcastMinDelayMs: 60000, broadcastMaxDelayMs: 60000, broadcastDailyLimit: 1000 } })
  await app.ok('POST', '/scheduled', { chat_ids: [x.id, y.id], text: 'slow broadcast' })
  await until(async () => (await outbound(x.id)).some((m: any) => m.text === 'slow broadcast'), 'broadcast queued')
  const quick = await app.ok('POST', `/chats/${x.id}/messages`, { text: 'human reply during broadcast' })
  await until(async () => (await messages(x.id)).find((m: any) => m.id === quick.id)?.status === 'delivered', 'human reply not blocked by broadcast', 2000)
  const before = (await app.ok('GET', '/chats')).length
  await app.stop(); await app.start()
  assert.equal((await app.ok('GET', '/chats')).length, before)
  await until(async () => (await app.ok('GET', '/numbers'))[0].status === 'connected', 'number to reconnect after restart')
  await simulate('still there?', '15550001')
  const chat = await chatByPhone('15550001')
  await until(async () => (await messages(chat.id)).at(-1).text === 'still there?', 'message after restart')
  assert.equal((await app.req('GET', '/chats', undefined, { key: apiKey })).status, 200)
  const stranded = (await outbound(x.id)).find((m: any) => m.text === 'slow broadcast')
  assert.equal(stranded.status, 'failed'); assert.match(stranded.error, /Interrupted by a server restart/)
})
