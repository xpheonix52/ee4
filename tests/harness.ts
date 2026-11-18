import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export async function until<T>(fn: () => Promise<T | false | null | undefined> | T | false | null | undefined, what: string, timeout = 8000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for: ${what}`)
    await sleep(40)
  }
}

export class App {
  proc?: ChildProcess
  cookie = ''
  constructor(public port: number, public dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-test-'))) {}
  get url() { return `http://127.0.0.1:${this.port}` }
  async start() {
    this.proc = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(this.port), DATA_DIR: this.dataDir, TICK_MS: '200' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    this.proc.stdout!.on('data', (d) => (log += d))
    this.proc.stderr!.on('data', (d) => (log += d))
    this.proc.on('exit', (c) => { if (c) console.error(`server exited ${c}\n${log}`) })
    await until(() => fetch(`${this.url}/healthz`).then((r) => r.ok).catch(() => false), 'server to start', 20000)
  }
  async stop() {
    if (!this.proc) return
    const done = new Promise((r) => this.proc!.once('exit', r))
    this.proc.kill()
    await done
  }
  async req(method: string, p: string, body?: any, opts: { key?: string; anon?: boolean } = {}) {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (opts.key) headers.authorization = `Bearer ${opts.key}`
    else if (!opts.anon && this.cookie) headers.cookie = this.cookie
    const res = await fetch(`${this.url}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const set = res.headers.get('set-cookie')
    if (set && !opts.anon && !opts.key) this.cookie = set.split(';')[0]
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, body: json }
  }
  /** Shorthand that fails loudly on a non-2xx response. */
  async ok(method: string, p: string, body?: any, opts?: { key?: string }) {
    const r = await this.req(method, p, body, opts)
    if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.body)}`)
    return r.body
  }
}

/** A tiny HTTP server that records every request; stands in for customer systems and LLM providers. */
export async function mockServer(handler: (req: { method: string; url: string; headers: http.IncomingHttpHeaders; body: any; raw: string }) => { status?: number; body?: any; type?: string } | Promise<any>) {
  const calls: any[] = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    let body: any = raw
    try { body = JSON.parse(raw) } catch { /* not json */ }
    const call = { method: req.method!, url: req.url!, headers: req.headers, body, raw }
    calls.push(call)
    const out = (await handler(call)) || {}
    res.writeHead(out.status || 200, { 'content-type': out.type || 'application/json' })
    res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body ?? { ok: true }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(r)) }
}

export const hmac = (secret: string, body: string) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`

/** Scripted OpenAI-compatible model: searches knowledge first, hands off when asked for a human. */
export function openAiMock() {
  return mockServer(({ body }) => {
    const msgs: any[] = body.messages
    const last = msgs[msgs.length - 1]
    const tools: string[] = (body.tools || []).map((t: any) => t.function.name)
    const say = (content: string) => ({ body: { choices: [{ message: { role: 'assistant', content } }] } })
    const call = (name: string, args: any) => ({ body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] } })
    if (last.role === 'tool') return say(`ANSWER: ${String(last.content).replace(/\s+/g, ' ').slice(0, 160)}`)
    if (/human|person/i.test(last.content) && tools.includes('handoff_to_human')) return call('handoff_to_human', { reason: 'asked for a person' })
    const ext = tools.find((t) => t.includes('__list_team'))
    if (/team/i.test(last.content) && ext) return call(ext, {})
    if (tools.includes('search_knowledge')) return call('search_knowledge', { query: last.content })
    return say(`GEN: ${String(last.content).slice(-120)}`)
  })
}

/** Scripted Anthropic Messages API model with the same behaviour. */
export function anthropicMock() {
  return mockServer(({ body, url }) => {
    if (!url.startsWith('/v1/messages')) return { status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'nope' } } }
    const msgs: any[] = body.messages
    const last = msgs[msgs.length - 1]
    const tools: string[] = (body.tools || []).map((t: any) => t.name)
    const wrap = (content: any[], stop_reason: string) => ({ body: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    const result = Array.isArray(last.content) ? last.content.find((b: any) => b.type === 'tool_result') : null
    if (result) return wrap([{ type: 'text', text: `CLAUDE: ${String(typeof result.content === 'string' ? result.content : JSON.stringify(result.content)).replace(/\s+/g, ' ').slice(0, 160)}` }], 'end_turn')
    const text = typeof last.content === 'string' ? last.content : last.content.map((b: any) => b.text || '').join(' ')
    if (tools.includes('search_knowledge')) return wrap([{ type: 'tool_use', id: 'toolu_1', name: 'search_knowledge', input: { query: text } }], 'tool_use')
    return wrap([{ type: 'text', text: `CLAUDE-GEN: ${text.slice(-120)}` }], 'end_turn')
  })
}
