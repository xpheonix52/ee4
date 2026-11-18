import { useEffect, useState } from 'react'
import { Bot, Plug, Send, Trash2 } from 'lucide-react'
import { api, useData } from '../api'
import { Field, Page, Toggle, useAction } from '../ui'
import { useApp } from '../App'

const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'], keyHint: 'From console.anthropic.com. Starts with sk-ant-.', baseHint: 'Leave empty unless you use a proxy.' },
  openai: { label: 'OpenAI-compatible', models: [], keyHint: 'Any provider with an OpenAI-style API: OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio…', baseHint: 'For example https://api.openai.com/v1 or http://localhost:11434/v1' },
} as const

export default function Agent() {
  const { numbers, refresh, me } = useApp()
  const run = useAction()
  const saved = useData('/ai/settings')
  const servers = useData<any[]>('/mcp-servers')
  const [s, setS] = useState<any>(null)
  const [srv, setSrv] = useState({ name: '', url: '', headers: '' })
  const [tools, setTools] = useState<Record<string, any>>({})
  const [chat, setChat] = useState<{ role: string; text: string; sources?: string[] }[]>([])
  const [msg, setMsg] = useState('')
  const [thinking, setThinking] = useState(false)
  useEffect(() => { if (saved.data && !s) setS(saved.data) }, [saved.data, s])
  if (!s) return <Page title="AI Agent">{null}</Page>
  const p = PROVIDERS[s.provider as keyof typeof PROVIDERS]
  const admin = me.role === 'admin'
  const set = (patch: any) => setS({ ...s, ...patch })

  const ask = async () => {
    const text = msg.trim()
    if (!text) return
    setMsg(''); setChat((c) => [...c, { role: 'user', text }]); setThinking(true)
    const r = await run(() => api('POST', '/ai/test', { message: text }))
    setThinking(false)
    if (r) setChat((c) => [...c, { role: 'agent', text: r.text, sources: r.sources }])
  }

  return (
    <Page title="AI Agent" subtitle="An assistant that answers customers from your knowledge hub, creates tickets, labels chats and hands off to your team. Bring any model, and give it extra tools through MCP.">
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          <div className="card space-y-4 p-5">
            <h2 className="font-medium">Model</h2>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map((k) => (
                <button key={k} type="button" onClick={() => set({ provider: k, model: k === 'anthropic' ? 'claude-opus-5-5' : s.provider === k ? s.model : '' })} className={`cursor-pointer rounded-xl border p-3 text-left text-sm font-medium ${s.provider === k ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>{PROVIDERS[k].label}</button>
              ))}
            </div>
            <Field label="API key" hint={p.keyHint}><input className="input font-mono" type="password" autoComplete="off" value={s.apiKey} onFocus={() => s.apiKey.includes('…') && set({ apiKey: '' })} onChange={(e) => set({ apiKey: e.target.value })} placeholder="Paste your key" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Model"><input className="input" list="model-options" value={s.model} onChange={(e) => set({ model: e.target.value })} placeholder={s.provider === 'openai' ? 'e.g. gpt-5 or llama3.1' : ''} /><datalist id="model-options">{p.models.map((m) => <option key={m} value={m} />)}</datalist></Field>
              <Field label="Base URL" hint={p.baseHint}><input className="input" value={s.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="Default" /></Field>
            </div>
          </div>
          <div className="card space-y-4 p-5">
            <h2 className="font-medium">Personality</h2>
            <Field label="Agent name"><input className="input" value={s.agentName} onChange={(e) => set({ agentName: e.target.value })} /></Field>
            <Field label="Instructions" hint="Tone, what to help with, what to never do. The knowledge hub supplies the facts."><textarea className="input" rows={6} value={s.instructions} onChange={(e) => set({ instructions: e.target.value })} /></Field>
            <Field label="Message when handing off to a human"><input className="input" value={s.handoffMessage} onChange={(e) => set({ handoffMessage: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><Toggle label="Reply in group chats" checked={s.replyInGroups} onChange={(v) => set({ replyInGroups: v })} />Also reply in group chats</label>
            {admin && <button className="btn btn-primary" onClick={async () => { const r = await run(() => api('PUT', '/ai/settings', s), 'AI agent settings saved'); if (r) { setS(r); refresh() } }}>Save settings</button>}
          </div>
          <div className="card p-5">
            <h2 className="font-medium">Where the agent replies</h2>
            <p className="mb-3 text-sm text-slate-500">Turn it on per number. You can override it for any single chat from the inbox.</p>
            {numbers.length === 0 && <p className="text-sm text-slate-500">Connect a number first.</p>}
            {numbers.map((n) => (
              <label key={n.id} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">{n.name}
                <Toggle label={`AI agent on ${n.name}`} checked={n.ai_enabled} onChange={(v) => admin && run(() => api('PATCH', `/numbers/${n.id}`, { ai_enabled: v })).then(refresh)} />
              </label>
            ))}
          </div>
          <div className="card p-5">
            <h2 className="flex items-center gap-2 font-medium"><Plug size={16} />Extra tools (MCP servers)</h2>
            <p className="mb-3 text-sm text-slate-500">Connect any MCP server and the agent can use its tools mid-conversation: your CRM, order system, calendar, internal hub.</p>
            <div className="space-y-2">
              {servers.data?.map((m) => (
                <div key={m.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <Toggle label={`Enable ${m.name}`} checked={m.enabled} onChange={(v) => run(() => api('PATCH', `/mcp-servers/${m.id}`, { enabled: v })).then(servers.reload)} />
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{m.name}</div><div className="truncate text-xs text-slate-500">{m.url}</div></div>
                    <button className="btn btn-outline !py-1" onClick={async () => { const r = await run(() => api('POST', `/mcp-servers/${m.id}/test`, {})); if (r) setTools({ ...tools, [m.id]: r }) }}>Test</button>
                    <button className="btn btn-danger !p-1.5" aria-label={`Remove ${m.name}`} onClick={() => run(() => api('DELETE', `/mcp-servers/${m.id}`)).then(servers.reload)}><Trash2 size={14} /></button>
                  </div>
                  {tools[m.id] && (tools[m.id].ok
                    ? <div className="mt-2 text-xs text-slate-600">Connected. {tools[m.id].tools.length} tools: {tools[m.id].tools.map((t: any) => t.name).join(', ')}</div>
                    : <div className="mt-2 text-xs text-red-600">Could not connect: {tools[m.id].error}</div>)}
                </div>
              ))}
            </div>
            {admin && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input className="input" placeholder="Name, e.g. CRM" aria-label="MCP server name" value={srv.name} onChange={(e) => setSrv({ ...srv, name: e.target.value })} />
                <input className="input" placeholder="https://example.com/mcp" aria-label="MCP server URL" value={srv.url} onChange={(e) => setSrv({ ...srv, url: e.target.value })} />
                <input className="input sm:col-span-2" placeholder='Headers as JSON (optional), e.g. {"Authorization": "Bearer …"}' aria-label="MCP server headers" value={srv.headers} onChange={(e) => setSrv({ ...srv, headers: e.target.value })} />
                <button className="btn btn-outline sm:col-span-2" disabled={!srv.name.trim() || !srv.url.trim()} onClick={async () => { if (await run(() => api('POST', '/mcp-servers', srv), 'MCP server added')) { setSrv({ name: '', url: '', headers: '' }); servers.reload() } }}>Add MCP server</button>
              </div>
            )}
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="card sticky top-4 flex h-[32rem] flex-col">
            <div className="border-b border-slate-200 px-4 py-3"><div className="flex items-center gap-2 font-medium"><Bot size={16} />Try it</div><div className="text-xs text-slate-500">Ask what a customer would ask. Nothing is sent to WhatsApp.</div></div>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {chat.length === 0 && <p className="text-sm text-slate-400">{saved.data?.has_key ? 'Type a question below.' : 'Add and save an API key first.'}</p>}
              {chat.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : ''}`}>
                  <div className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm ${m.role === 'user' ? 'bg-[#d9fdd3]' : 'bg-slate-100'}`}>
                    <div className="whitespace-pre-wrap">{m.text}</div>
                    {!!m.sources?.length && <div className="mt-1 text-xs text-slate-500">Used: {[...new Set(m.sources)].join(', ')}</div>}
                  </div>
                </div>
              ))}
              {thinking && <div className="text-sm text-slate-400">Thinking…</div>}
            </div>
            <div className="flex gap-2 border-t border-slate-200 p-3">
              <input className="input" placeholder="Ask the agent something" aria-label="Test message" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
              <button className="btn btn-primary !p-2" onClick={ask} disabled={thinking || !msg.trim()} aria-label="Ask"><Send size={16} /></button>
            </div>
          </div>
        </div>
      </div>
    </Page>
  )
}
