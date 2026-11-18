# Switchboard

A self-hosted WhatsApp workspace for teams: one shared inbox for many numbers, tickets, automations,
an AI agent with a knowledge hub, a REST API, webhooks and an MCP server.

It links regular WhatsApp and WhatsApp Business app numbers as a companion device (QR code or pairing
code). No Meta Business API, no template approval, no per-message fees.

## Run it

```bash
docker compose up -d --build
```

Open `http://<your-server>:3000`, create the admin account, then follow the checklist on the home page.
Everything (database, WhatsApp logins, media) is stored in the `switchboard-data` volume, so upgrades are
`git pull && docker compose up -d --build`.

The server must stay on: a WhatsApp link is a live connection. Put it behind HTTPS (Caddy, nginx,
Cloudflare Tunnel) and then set `COOKIE_SECURE=true` and `TRUST_PROXY=1` in `docker-compose.yml`.

Without Docker: `npm ci && npm run build && npm start` (Node 22+). For development: `npm run dev`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | Database, WhatsApp sessions, media |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy so login throttling sees real IPs |
| `HTTPS_PROXY` | unset | Route WhatsApp traffic through a proxy |

## What is in it

- **Numbers**: link any number of WhatsApp numbers. Sandbox numbers simulate chats so you can try
  everything (and run the test suite) without a phone.
- **Inbox**: direct and group chats from every number, live. Assignment, labels, private notes, quick
  replies (`/`), attachments, open/closed, AI draft and summary.
- **Tickets**: board with status, priority and assignee, linked to chats.
- **Automations**: trigger (message received or sent, new chat, ticket created or updated, inbound
  webhook, schedule), conditions, then any number of steps: send message, AI reply, ask AI, label,
  assign, create ticket, note, HTTP request, toggle the agent, close chat, wait. Text fields accept
  variables such as `{{message.text}}`, `{{contact.name}}`, `{{ai.output}}`, `{{http.json.id}}`,
  `{{webhook.order}}`. Templates included; every run is logged.
- **AI agent**: answers from the knowledge hub, creates tickets, labels chats and hands off to a person.
  Works with Claude (Anthropic) or any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Ollama…).
  Add external MCP servers and the agent can use their tools.
- **Knowledge hub**: paste text, import a web page or upload a file; full-text search (SQLite FTS5).
- **Broadcasts and scheduled messages**: one-off or repeating, paced with random delays and a daily cap.
- **API and MCP**: REST API under `/api/v1`, signed outgoing webhooks, live event stream, and an MCP
  server at `/mcp` (Streamable HTTP). One API key works for both. The in-app **API & MCP** page has
  copy-paste snippets.

## Using a number safely

This uses the WhatsApp Web protocol (via Baileys), not an official Meta API. WhatsApp can restrict
numbers that behave like bots. Keep the default sending delays, message people who expect to hear from
you, warm up new numbers gradually, and avoid cold bulk messaging. Switchboard also stops auto-replying
after 8 automated messages in a row in one chat, to break bot-to-bot loops.

## Quality loop

```bash
npm run qa   # typecheck, backend suite, then a browser bot that drives the real UI
```

- `tests/api.test.ts`: 14 scenarios against a real server process, with scripted customers on a sandbox
  number, mock LLM providers (OpenAI-style and Anthropic), a mock CRM, a webhook receiver and an MCP client.
- `tests/e2e.test.ts`: 11 browser scenarios (Playwright) from first-run setup to a teammate signing in,
  including a phone-sized viewport and a zero-console-errors check.
- `npx tsx tests/wa-probe.ts`: checks that this machine can reach WhatsApp and obtain a pairing QR.

## Layout

```
server/   Express API, WhatsApp transports (wa.ts), messaging core, automations, AI, MCP, scheduler
web/      React + Tailwind UI
tests/    Backend and browser suites
```

Single process, single SQLite file. Back up by copying the data volume.
