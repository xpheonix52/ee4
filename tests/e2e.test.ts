// Browser QA bot: drives the real UI like a new user would, with a scripted "customer" on a sandbox number.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { App, openAiMock } from './harness.ts'

const { chromium } = createRequire(import.meta.url)('playwright')
const app = new App(4320)
const shots = process.env.SHOTS_DIR
let browser: any, page: any, llm: any
const problems: string[] = []

const shot = async (name: string) => { if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: `${shots}/${name}.png` }) } }
const customer = async (text: string, from = '15557001', name = 'Maya') => {
  const numbers = await app.ok('GET', '/numbers')
  await app.ok('POST', `/numbers/${numbers[0].id}/simulate`, { from, name, text })
}
const nav = (label: string) => page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: label }).click()
const see = (text: string | RegExp, opts: any = {}) => page.getByText(text, opts).first().waitFor({ timeout: 8000 })

before(async () => {
  llm = await openAiMock()
  await app.start()
  browser = await chromium.launch()
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (e: Error) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m: any) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`) })
  page.on('dialog', (d: any) => d.accept())
})
after(async () => { await browser?.close(); await app.stop(); await llm.close() })

test('first run: create the workspace and land on the checklist', async () => {
  await page.goto(app.url)
  await see('Welcome to Switchboard')
  await page.getByLabel('Team or company name').fill('Acme Co')
  await page.getByLabel('Your name').fill('Olivia Owner')
  await page.getByLabel('Email').fill('olivia@acme.test')
  await page.getByLabel('Password').fill('correct-horse-1')
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await see('Hi Olivia')
  await see('Get set up · 0 of 5 done')
  await shot('01-home')
  app.cookie = (await page.context().cookies()).filter((c: any) => c.name === 'sb_session').map((c: any) => `${c.name}=${c.value}`)[0]
  await app.ok('PUT', '/settings', { sending: { minDelayMs: 0, maxDelayMs: 0, broadcastMinDelayMs: 0, broadcastMaxDelayMs: 0 } })
})

test('connect a sandbox number', async () => {
  await nav('Numbers')
  await page.getByRole('button', { name: 'Add number' }).first().click()
  await page.getByRole('button', { name: /Sandbox number/ }).click()
  await page.getByLabel('Name').fill('Demo line')
  await page.getByRole('button', { name: 'Create sandbox number' }).click()
  await page.getByTestId('number-card').getByText('Connected').waitFor()
  await shot('02-numbers')
})

test('inbox: live incoming message, reply, note, label, ticket', async () => {
  await nav('Inbox')
  await see('No chats yet')
  await customer('Hi, is anyone there?')
  await page.getByTestId('chat-list').getByText('Maya', { exact: true }).waitFor()
  await page.getByTestId('unread-badge').getByText('1').waitFor()
  await page.getByTestId('chat-list').getByText('Maya', { exact: true }).click()
  await page.getByTestId('messages').getByText('Hi, is anyone there?').waitFor()

  await page.getByLabel('Message', { exact: true }).fill('Hello Maya, how can I help?')
  await page.keyboard.press('Enter')
  const mine = page.getByTestId('messages').locator('div', { hasText: 'Hello Maya, how can I help?' }).last()
  await mine.waitFor()
  await page.getByTestId('messages').getByLabel('Delivered').first().waitFor()
  assert.equal(await page.getByTestId('unread-badge').count(), 0, 'opening the chat clears the unread badge')

  // The sandbox bar lets a person play the customer straight from the UI.
  await page.getByLabel('Simulate customer message').fill('What does it cost?')
  await page.getByRole('button', { name: 'Receive' }).click()
  await page.getByTestId('messages').getByText('What does it cost?').waitFor()

  await page.getByRole('button', { name: 'Private note' }).click()
  await page.getByLabel('Private note').fill('Maya is a returning customer')
  await page.getByRole('button', { name: 'Add note' }).click()
  await page.getByTestId('messages').getByText('Maya is a returning customer').waitFor()

  await page.getByLabel('Add a label').fill('VIP')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByTestId('chat-list').getByText('VIP').waitFor()
  await page.getByLabel('Assigned to').selectOption({ label: 'Olivia Owner (you)' })
  await page.getByLabel('New ticket title').fill('Send Maya a quote')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await see('#1 Send Maya a quote')
  await page.getByRole('button', { name: 'Mine' }).click()
  await page.getByTestId('chat-list').getByText('Maya', { exact: true }).waitFor()
  await shot('03-inbox')
})

test('tickets board moves a ticket through its stages', async () => {
  await nav('Tickets')
  await page.getByTestId('column-open').getByText('#1 Send Maya a quote').waitFor()
  await page.getByLabel('Status of ticket 1').selectOption('in_progress')
  await page.getByTestId('column-in_progress').getByText('#1 Send Maya a quote').waitFor()
  await shot('04-tickets')
})

test('automations: build one in the UI and watch it answer a customer', async () => {
  await nav('Automations')
  await page.getByRole('button', { name: 'Browse templates' }).click()
  await page.getByRole('button', { name: /Start from scratch/ }).click()
  await page.getByLabel('Name').fill('Pricing auto-reply')
  await page.getByRole('button', { name: 'Add condition' }).click()
  await page.getByLabel('Condition value').fill('price, cost')
  await page.getByLabel('Message', { exact: true }).fill('Hi {{contact.name}}, plans start at $10 a month.')
  await page.getByRole('button', { name: 'Add step' }).click()
  await page.getByLabel('Step 2 action').selectOption('add_label')
  await page.getByTestId('action-card').nth(1).getByLabel('Label').fill('Lead')
  await shot('05-automation-builder')
  await page.getByRole('button', { name: 'Save automation' }).click()
  await page.getByTestId('automation-row').getByText('Pricing auto-reply').waitFor()

  // A template can be used as-is, and the builder reopens with saved values.
  await page.getByRole('button', { name: 'New automation' }).click()
  await page.getByRole('button', { name: /Create tickets from keywords/ }).click()
  await page.getByRole('button', { name: 'Save automation' }).click()
  await page.getByTestId('automation-row').getByText('Create tickets from keywords').waitFor()
  await page.getByTestId('automation-row').getByText('Pricing auto-reply').click()
  assert.equal(await page.getByLabel('Condition value').inputValue(), 'price, cost')
  await page.getByRole('button', { name: 'Cancel' }).click()

  await customer('how much does it cost?', '15557002', 'Noah')
  await nav('Inbox')
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await page.getByTestId('chat-list').getByText('Noah', { exact: true }).click()
  await page.getByTestId('messages').getByText('Hi Noah, plans start at $10 a month.').waitFor()
  await see(/Automation · Pricing auto-reply/)
  await page.getByTestId('chat-list').getByText('Lead').waitFor()
  await nav('Automations')
  await page.getByRole('button', { name: '1 run', exact: true }).click()
  await see('Succeeded')
  await page.getByRole('button', { name: 'Close' }).click()
})

test('knowledge hub and AI agent: configure, try it, then let it answer on WhatsApp', async () => {
  await app.ok('PUT', '/ai/settings', { responseDelaySeconds: 0, snoozeSeconds: 0 })
  await nav('Knowledge')
  await page.getByRole('button', { name: 'Add document' }).click()
  await page.getByLabel('Title').fill('Opening hours')
  await page.getByLabel('Content').fill('We are open Monday to Saturday from 8am to 8pm. We are closed on Sundays.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByLabel('Test search').fill('are you open on sunday')
  await page.getByRole('button', { name: 'Search' }).click()
  await see(/closed on Sundays/)
  await shot('06-knowledge')

  // Train with an FAQ that carries handling instructions.
  await page.getByRole('tab', { name: /FAQs/ }).click()
  await page.getByRole('button', { name: 'Add an FAQ' }).click()
  await page.getByLabel('Customer question').fill('Do you offer refunds?\nmoney back')
  await page.getByLabel('Answer').fill('Yes, within 30 days of purchase.')
  await page.getByLabel('Instructions for the agent (optional)').fill('If they are angry, hand off to a human.')
  await page.getByRole('button', { name: 'Save FAQ' }).click()
  await page.getByTestId('faq-row').getByText('Do you offer refunds?').waitFor()
  await see('Has instructions')

  await nav('AI Agent')
  await see('The agent needs a model before it can reply.')
  await page.getByRole('tab', { name: 'Model' }).click()
  // Pasting a key picks the provider by itself.
  await page.getByLabel('API key').fill('sk-or-v1-some-openrouter-key')
  assert.equal(await page.getByRole('button', { name: /OpenRouter/ }).getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: /^Other/ }).click()
  await page.getByLabel('API key').fill('sk-e2e-test-key')
  await page.getByLabel('Base URL').fill(`${llm.url}/v1`)
  // The exact mistake a real user made: a vague model name. The app explains it and offers the real ones.
  await page.getByLabel('Model', { exact: true }).fill('sonnet')
  await page.getByRole('button', { name: 'Save and test' }).click()
  await see(/does not have a model called "sonnet"/)
  await shot('07-model-error')
  await page.getByRole('alert').getByRole('button', { name: 'vendor/sonnet-9' }).click()
  await see(/Connected\./)
  assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), 'vendor/sonnet-9')
  await shot('07-model-ok')

  await page.getByRole('tab', { name: 'Persona' }).click()
  await page.getByLabel('Agent name').fill('Sunny')
  await page.getByRole('button', { name: /Spartan/ }).click()
  await page.getByLabel('Restrictions').fill('Never promise delivery dates.')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await see('AI agent settings saved')
  await shot('07-agent-persona')
  await page.getByLabel('Test message').fill('When are you open?')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  await see(/ANSWER:/)
  await see('Did: search knowledge')
  await see('Used: Opening hours')
  const sys = llm.calls.at(-1).body.messages[0].content
  assert.match(sys, /Your name is Sunny/); assert.match(sys, /ultra-brief/); assert.match(sys, /Never promise delivery dates\./)

  // A custom HTTP tool, created in the UI.
  await page.getByRole('tab', { name: 'Tools' }).click()
  await page.getByRole('button', { name: 'Add tool' }).click()
  await page.getByLabel('Tool name').fill('Get Order Status')
  await page.getByLabel('When should the AI use it?').fill('Look up an order by id')
  await page.getByRole('dialog').getByLabel('URL').fill(`${llm.url}/orders/{order_id}`)
  await page.getByRole('button', { name: 'Add parameter' }).click()
  await page.getByLabel('Parameter name').fill('order_id')
  await page.getByRole('button', { name: 'Save tool' }).click()
  await page.getByTestId('tool-row').getByText('get_order_status').waitFor()

  await page.getByRole('tab', { name: 'When it replies' }).click()
  await page.getByRole('switch', { name: 'AI agent on Demo line' }).click()
  await shot('07-agent')

  await customer('are you open on sunday?', '15557003', 'Priya')
  await nav('Inbox')
  await page.getByTestId('chat-list').getByText('Priya', { exact: true }).click()
  await page.getByTestId('messages').getByText(/ANSWER: .*closed on Sundays/).waitFor()
  await see('AI agent', { exact: true })
  await see('· AI agent on')

  // Asking for a person hands the chat to the team and silences the agent.
  await customer('can I talk to a human?', '15557003', 'Priya')
  await page.getByTestId('chat-list').getByText('Needs human').waitFor()
  await page.getByTestId('messages').getByText(/AI handed off/).waitFor()
  assert.equal(await page.getByLabel('AI agent in this chat').inputValue(), 'off')
  await page.getByRole('button', { name: 'AI draft' }).click()
  await page.waitForFunction(() => /ANSWER/.test((document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement)?.value || ''))
  await shot('08-inbox-ai')
})

test('self-training learns from a teammate, and the assistant works across the workspace', async () => {
  await nav('AI Agent')
  await page.getByRole('tab', { name: 'Training' }).click()
  await page.getByRole('button', { name: 'Run training now' }).click()
  await page.getByRole('cell', { name: 'Complete' }).first().waitFor()
  await page.getByRole('tab', { name: 'Logs' }).click()
  await see('Replied')
  await see(/search_knowledge/)
  await shot('12-agent-logs')

  await nav('Assistant')
  await page.getByLabel('Ask the assistant').fill('who is on the team?')
  await page.getByRole('button', { name: 'Send to assistant' }).click()
  await see(/olivia@acme\.test/)
  await see(/Used 1 tool call: list team/)
  await shot('13-assistant')

  // Inbox extras: needs-reply filter, custom properties, ticket straight from a message.
  await customer('Is my warranty still valid?', '15557004', 'Quinn')
  await nav('Inbox')
  // Maya asked last and nobody answered; Quinn was answered by the agent, so only Maya is waiting on us.
  await page.getByRole('button', { name: 'Needs reply' }).click()
  await page.getByTestId('chat-list').getByText('Maya', { exact: true }).waitFor()
  await page.getByTestId('messages').getByText(/ANSWER/).first().waitFor().catch(() => {})
  await page.getByRole('button', { name: 'All', exact: true }).click()
  await page.getByTestId('chat-list').getByText('Quinn', { exact: true }).click()
  await page.getByTestId('messages').getByText(/ANSWER/).first().waitFor()
  await page.getByRole('button', { name: 'Needs reply' }).click()
  await page.getByTestId('chat-list').getByText('Quinn', { exact: true }).waitFor({ state: 'detached' })
  await page.getByLabel('Property name').fill('plan')
  await page.getByLabel('Property value').fill('Gold')
  await page.getByRole('button', { name: 'Set', exact: true }).click()
  await page.getByLabel('Value of plan').waitFor()
  const bubble = page.getByTestId('messages').getByText('Is my warranty still valid?')
  await bubble.hover()
  await page.getByRole('button', { name: 'Create a ticket from this message' }).first().click()
  await see(/#\d+ Is my warranty still valid\?/)
  await page.getByRole('button', { name: 'All', exact: true }).click()
})

test('API & MCP: create a key in the UI and use it from an MCP client', async () => {
  await nav('API & MCP')
  await page.getByLabel('API key name').fill('QA bot')
  await page.getByRole('button', { name: 'Create key' }).click()
  await see('Copy this key now')
  const key = (await page.locator('code', { hasText: /^sb_/ }).first().innerText()).trim()
  assert.match(key, /^sb_[\w-]{30,}$/)
  await shot('09-developers')

  const client = new Client({ name: 'qa-bot', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }))
  const chats = JSON.parse(((await client.callTool({ name: 'list_chats', arguments: { query: 'Maya' } })) as any).content[0].text)
  await client.callTool({ name: 'send_message', arguments: { chat_id: chats[0].id, text: 'Your quote is ready (sent via MCP)' } })
  await client.close()
  await nav('Inbox')
  await page.getByTestId('chat-list').getByText('Maya', { exact: true }).click()
  await page.getByTestId('messages').getByText('Your quote is ready (sent via MCP)').waitFor()
})

test('broadcast to several chats', async () => {
  await nav('Broadcasts')
  await page.getByRole('button', { name: 'New message' }).first().click()
  await page.getByRole('dialog').getByText('Maya', { exact: true }).click()
  await page.getByRole('dialog').getByText('Noah', { exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('We are closed this Friday for a public holiday.')
  await page.getByRole('button', { name: 'Send to 2 chats' }).click()
  await page.getByTestId('scheduled-row').getByText('Sent', { exact: true }).waitFor({ timeout: 8000 }).catch(async () => { await page.reload(); await page.getByTestId('scheduled-row').getByText('Sent', { exact: true }).waitFor() })
  await nav('Inbox')
  await page.getByTestId('chat-list').getByText('Noah', { exact: true }).click()
  await page.getByTestId('messages').getByText('We are closed this Friday for a public holiday.').waitFor()
})

test('team: add a teammate who can work the inbox but not admin areas', async () => {
  await nav('Settings')
  await page.getByLabel('Teammate name').fill('Sam Agent')
  await page.getByLabel('Teammate email').fill('sam@acme.test')
  await page.getByLabel('Temporary password').fill('agent-pass-123')
  await page.getByRole('button', { name: 'Add teammate' }).click()
  await see('sam@acme.test')
  await page.getByLabel('Quick reply shortcut').fill('hours')
  await page.getByLabel('Quick reply text').fill('We are open Monday to Saturday, 8am to 8pm.')
  await page.getByRole('button', { name: 'Add quick reply' }).click()
  await see('/hours')
  await shot('10-settings')

  await page.getByRole('button', { name: /Sign out/ }).click()
  await see('Sign in')
  await page.getByLabel('Email').fill('sam@acme.test')
  await page.getByLabel('Password').fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await see('Wrong email or password')
  await page.getByLabel('Password').fill('agent-pass-123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await see('Hi Sam')
  await nav('API & MCP')
  await see('Only admins can manage API keys and webhooks.')
  await nav('Inbox')
  await page.getByTestId('chat-list').getByText('Priya', { exact: true }).click()
  await page.getByLabel('Message', { exact: true }).fill('/ho')
  await page.keyboard.press('Enter') // picks the quick reply
  assert.equal(await page.getByLabel('Message', { exact: true }).inputValue(), 'We are open Monday to Saturday, 8am to 8pm.')
  await page.keyboard.press('Enter')
  await page.getByTestId('messages').getByText('We are open Monday to Saturday, 8am to 8pm.').waitFor()
  await page.reload() // a hard refresh on a deep link keeps you signed in and in the same chat
  await page.getByTestId('chat-title').getByText('Priya').waitFor()
})

test('works on a phone-sized screen without sideways scrolling', async () => {
  await page.setViewportSize({ width: 390, height: 800 })
  for (const path of ['/', '/inbox', '/automations', '/agent', '/assistant', '/tickets', '/settings', '/knowledge', '/broadcasts', '/numbers']) {
    await page.goto(app.url + path)
    await page.waitForLoadState('networkidle')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `${path} scrolls sideways by ${overflow}px on mobile`)
  }
  await page.goto(`${app.url}/inbox`)
  await page.getByTestId('chat-list').getByText('Priya', { exact: true }).click()
  await page.getByTestId('chat-title').getByText('Priya').waitFor()
  await shot('11-mobile-chat')
  await page.getByRole('button', { name: 'Back to chats' }).click()
  await page.getByTestId('chat-list').getByText('Maya', { exact: true }).waitFor()
})

test('no browser errors anywhere along the way', () => {
  assert.deepEqual(problems, [])
})
