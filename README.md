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

The server must stay on: a WhatsApp link is a live connection.

**HTTPS.** Run `scripts/enable-https.sh` on the server. With no argument it uses a free name for the
server's IP (for example `https://72-60-194-113.sslip.io`); pass your own domain once its DNS points at the
server (`scripts/enable-https.sh chat.example.com`). Caddy fetches and renews the certificate, and the app
stops being reachable over plain HTTP. Ports 80 and 443 must be open.

**Hosted option:** `render.yaml` is a Render blueprint (New > Blueprint > this repo) that builds the
Dockerfile and attaches a persistent disk. Any host that runs a Docker container with a volume works
(Railway, Fly.io, a VPS). Static hosts such as Netlify or Vercel cannot run it: the app is a long-running
server that holds live WhatsApp connections.

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
- **AI agent**: answers from the knowledge hub, creates tickets, writes private notes, labels chats and
  hands off to a person. Works with Claude (Anthropic) or any OpenAI-compatible endpoint (OpenAI,
  OpenRouter, Groq, Ollama…).
  - *Persona*: name, personality preset (friendly, strict grounded, spartan, sales forward), role and
    instructions, hard restrictions, hand-off message.
  - *When it replies*: per number and per chat, active hours, a wait that lets a teammate answer first,
    a quiet period after a teammate replies, plain-language activation rules, internal contacts.
  - *Tools*: switch built-in abilities on or off (including a silent mode that drafts into notes),
    custom HTTP tools with auth and typed parameters, and MCP connectors with per-tool switches.
  - *Training*: FAQs with question variations and handling instructions, documents, and weekly
    self-training that drafts FAQs from your team's real answers (with review before use).
  - *Logs*: every reply, skipped message and tool call. *Playground*: multi-turn test chat.
- **Assistant**: a workspace assistant for the team. Ask it to find chats, bulk-label or assign, update
  tickets, audit the knowledge hub or build automations. It uses the same tools as the MCP server.
- **Knowledge hub**: FAQs plus documents (paste text, import a web page, upload PDF or text files);
  full-text search (SQLite FTS5). Feed it from outside with `POST /api/v1/knowledge`, `POST /api/v1/faqs`
  or the `add_knowledge` / `add_faq` MCP tools.
- **Monitoring and follow-up**: time-based triggers ("customer has waited N minutes", "customer quiet for N
  hours"), one-click follow-up reminders on any chat, a Follow up inbox view, 28 templates in 7 categories,
  and starter automations installed on a new workspace (only the one that never messages customers starts on).
- **Flagging**: customer questions, requests and problems are flagged automatically (rule-based, or AI with
  your own criteria), highlighted in the chat, and collected under a Flagged tab until someone replies.
- **Analytics**: per-teammate messages, chats handled and average reply time; ticket totals and time to
  resolve; 7, 30 or 90 days. **Activity log** of who changed what.
- **Team work**: @mention teammates in private notes (Mentions tab), filter the inbox by label, drag
  tickets between columns, personalise bulk messages with `{{contact.name}}`.
- **Composer**: send later, AI rewrite (fix grammar, shorter, friendlier, translate), AI draft and summary.
- **Also**: custom chat properties (visible to the agent and usable in automations), emoji ticketing
  (react to a message to raise a ticket), a "Needs reply" inbox view, tickets from any message, CSV exports.
- **Broadcasts and scheduled messages**: one-off or repeating, paced with random delays and a daily cap.
- **API and MCP**: REST API under `/api/v1`, signed outgoing webhooks, live event stream, and an MCP
  server at `/mcp` (Streamable HTTP). One API key works for both. The in-app **API & MCP** page has
  copy-paste snippets.

## Updates and backups

**Automatic updates.** On the server, run `scripts/install-auto-update.sh` once. Every 5 minutes it checks
GitHub and, when the branch has new commits, rebuilds and restarts. A failed build rolls back and retries.
Log: `/var/log/switchboard-update.log`.

**Backups.** A backup is one `.tar.gz` with a consistent copy of the database (chats, automations,
knowledge, settings, team) and the WhatsApp logins; attachments are optional. One is made every night and
the last 14 are kept in the data volume (Settings > Backups lists and downloads them). Keep a copy off the
server too. From any other machine, with an API key:

```bash
curl -fsS -H "Authorization: Bearer YOUR_API_KEY" http://YOUR_SERVER:3000/api/v1/backups/latest \
  -o switchboard-$(date +%F).tar.gz        # add ?media=true to include attachments
```

**Restore** (same server or a new one): `scripts/restore.sh switchboard-2026-01-01.tar.gz`.

## Using a number safely

This uses the WhatsApp Web protocol (via Baileys), not an official Meta API. WhatsApp can restrict
numbers that behave like bots. Keep the default sending delays, message people who expect to hear from
you, warm up new numbers gradually, and avoid cold bulk messaging. Switchboard also stops auto-replying
after 8 automated messages in a row in one chat, to break bot-to-bot loops.

## Quality loop

```bash
npm run qa   # typecheck, backend suite, then a browser bot that drives the real UI
```

- `tests/api.test.ts`: 17 scenarios against a real server process, with scripted customers on a sandbox
  number, mock LLM providers (OpenAI-style and Anthropic), a mock CRM, a webhook receiver and an MCP client.
- `tests/e2e.test.ts`: 12 browser scenarios (Playwright) from first-run setup to a teammate signing in,
  including a phone-sized viewport and a zero-console-errors check.
- `npx tsx tests/wa-probe.ts`: checks that this machine can reach WhatsApp and obtain a pairing QR.

## Layout

```
server/   Express API, WhatsApp transports (wa.ts), messaging core, automations, AI, MCP, scheduler
web/      React + Tailwind UI
tests/    Backend and browser suites
```

Single process, single SQLite file. Back up by copying the data volume.
