import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data')
fs.mkdirSync(path.join(DATA_DIR, 'media'), { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, 'wa-auth'), { recursive: true })

export const db = new Database(path.join(DATA_DIR, 'switchboard.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER);
CREATE TABLE IF NOT EXISTS numbers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, phone TEXT, status TEXT NOT NULL DEFAULT 'disconnected',
  ai_enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, number_id TEXT NOT NULL REFERENCES numbers(id) ON DELETE CASCADE, jid TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'dm', name TEXT, phone TEXT, unread INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER, last_message_preview TEXT, assignee_id TEXT, status TEXT NOT NULL DEFAULT 'open',
  ai_mode TEXT NOT NULL DEFAULT 'default', created_at INTEGER NOT NULL, UNIQUE(number_id, jid)
);
CREATE INDEX IF NOT EXISTS chats_last ON chats(last_message_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, wa_id TEXT,
  direction TEXT NOT NULL, sender_jid TEXT, sender_name TEXT, type TEXT NOT NULL DEFAULT 'text', text TEXT,
  media_path TEXT, media_mime TEXT, media_name TEXT, status TEXT NOT NULL DEFAULT 'sent', sent_by TEXT,
  error TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa ON messages(chat_id, wa_id) WHERE wa_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_labels (chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE, PRIMARY KEY(chat_id, label_id));
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL, message_id TEXT,
  title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium',
  assignee_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quick_replies (id TEXT PRIMARY KEY, shortcut TEXT UNIQUE NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '[]', match TEXT NOT NULL DEFAULT 'all', actions TEXT NOT NULL DEFAULT '[]',
  cooldown_minutes INTEGER NOT NULL DEFAULT 0, hook_token TEXT NOT NULL, last_schedule_key TEXT,
  run_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, chat_id TEXT,
  status TEXT NOT NULL, summary TEXT, log TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_auto ON automation_runs(automation_id, created_at DESC);
CREATE TABLE IF NOT EXISTS kb_docs (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'text', url TEXT, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks USING fts5(doc_id UNINDEXED, title, body, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL, ok INTEGER NOT NULL, status_code INTEGER, attempts INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduled (
  id TEXT PRIMARY KEY, name TEXT, chat_ids TEXT NOT NULL, text TEXT NOT NULL, send_at INTEGER NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none', status TEXT NOT NULL DEFAULT 'pending', sent_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS kb_faqs (
  id TEXT PRIMARY KEY, questions TEXT NOT NULL, answer TEXT NOT NULL, instructions TEXT, status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_tools (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT NOT NULL, method TEXT NOT NULL DEFAULT 'GET', url TEXT NOT NULL,
  auth TEXT NOT NULL DEFAULT '{"type":"none"}', headers TEXT NOT NULL DEFAULT '{}', params TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_logs (id TEXT PRIMARY KEY, chat_id TEXT, kind TEXT NOT NULL, input TEXT, output TEXT, trace TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ai_logs_at ON ai_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS training_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, trigger TEXT NOT NULL, learned INTEGER NOT NULL DEFAULT 0, chats INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL);
`)
// Columns added after the first release: applied in place so existing installs upgrade without losing data.
function addColumn(table: string, column: string, ddl: string) {
  if (!(db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
}
addColumn('chats', 'props', `TEXT NOT NULL DEFAULT '{}'`)
addColumn('chats', 'internal', 'INTEGER NOT NULL DEFAULT 0')
addColumn('chats', 'ai_snooze_until', 'INTEGER')
addColumn('messages', 'flagged', 'INTEGER NOT NULL DEFAULT 0')
db.exec('CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)')
addColumn('chats', 'follow_up_at', 'INTEGER')
addColumn('chats', 'follow_up_note', 'TEXT')
addColumn('chats', 'follow_up_notified', 'INTEGER NOT NULL DEFAULT 0')
addColumn('mcp_servers', 'disabled_tools', `TEXT NOT NULL DEFAULT '[]'`)

export const now = () => Date.now()
export const id = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`
export const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url')
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16).toString('hex')
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`
}
export function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(':')
  const a = crypto.scryptSync(pw, salt, 32)
  const b = Buffer.from(hash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export type Settings = {
  workspace: { name: string; timezoneOffsetMinutes: number }
  businessHours: { enabled: boolean; days: number[]; start: string; end: string }
  sending: { minDelayMs: number; maxDelayMs: number; broadcastMinDelayMs: number; broadcastMaxDelayMs: number; broadcastDailyLimit: number }
  flagging: { mode: 'smart' | 'ai' | 'off'; rules: string }
  ai: {
    provider: 'anthropic' | 'openai'; apiKey: string; baseUrl: string; model: string
    agentName: string; instructions: string; replyInGroups: boolean; handoffMessage: string
    personality: 'friendly' | 'grounded' | 'spartan' | 'sales'; restrictions: string
    hours: 'always' | 'business' | 'outside'; responseDelaySeconds: number; snoozeSeconds: number; activationRules: string
    allowSend: boolean; allowTickets: boolean; allowNotes: boolean
    selfTrainWeekly: boolean; selfLearnApproval: boolean
  }
}
const DEFAULTS: Settings = {
  workspace: { name: 'My Team', timezoneOffsetMinutes: 0 },
  businessHours: { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  sending: { minDelayMs: 1500, maxDelayMs: 4000, broadcastMinDelayMs: 8000, broadcastMaxDelayMs: 20000, broadcastDailyLimit: 200 },
  flagging: { mode: 'smart', rules: '' },
  ai: {
    provider: 'anthropic', apiKey: '', baseUrl: '', model: 'claude-opus-5-5', agentName: 'Assistant',
    instructions: 'You are a friendly, concise support assistant replying on WhatsApp. Answer using the knowledge hub. If you are not sure or the customer asks for a person, hand off to a human.',
    replyInGroups: false, handoffMessage: 'Let me connect you with a teammate who can help. They will reply here shortly.',
    personality: 'friendly', restrictions: '', hours: 'always', responseDelaySeconds: 3, snoozeSeconds: 60, activationRules: '',
    allowSend: true, allowTickets: true, allowNotes: true, selfTrainWeekly: true, selfLearnApproval: true,
  },
}
export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return { ...DEFAULTS[key], ...(row ? JSON.parse(row.value) : {}) }
}
export function setSetting<K extends keyof Settings>(key: K, value: Partial<Settings[K]>) {
  const merged = { ...getSetting(key), ...value }
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(merged))
  return merged
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
