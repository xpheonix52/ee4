import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { db } from './db.js'

type Server = { id: string; name: string; url: string; headers: string; enabled: number }

async function withClient<T>(s: Server, fn: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: JSON.parse(s.headers || '{}') } })
  const client = new Client({ name: 'switchboard', version: '0.1.0' })
  await client.connect(transport)
  try { return await fn(client) } finally { await client.close().catch(() => {}) }
}

const cache = new Map<string, { at: number; tools: any[] }>()
export async function listServerTools(s: Server, fresh = false) {
  const hit = cache.get(s.id)
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.tools
  const tools = await withClient(s, async (c) => (await c.listTools()).tools)
  cache.set(s.id, { at: Date.now(), tools })
  return tools
}
export function forgetServer(serverId: string) { cache.delete(serverId) }

/** Tools from every enabled external MCP server, ready to hand to the AI agent. */
export async function externalTools() {
  const out: { name: string; description: string; schema: any; run: (input: any) => Promise<string> }[] = []
  for (const s of db.prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all() as Server[]) {
    try {
      const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)
      for (const t of await listServerTools(s)) {
        out.push({
          name: `${slug}__${t.name}`.slice(0, 64), description: t.description || t.name, schema: t.inputSchema,
          run: async (input) => {
            const r: any = await withClient(s, (c) => c.callTool({ name: t.name, arguments: input }))
            return (r.content || []).map((b: any) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n') || 'ok'
          },
        })
      }
    } catch (e: any) {
      console.error(`[mcp] ${s.name} unavailable: ${e?.message || e}`)
    }
  }
  return out
}
