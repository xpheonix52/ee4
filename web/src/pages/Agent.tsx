import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bot, Pencil, Plus, Send, Trash2 } from 'lucide-react'
import { api, dateTime, useData } from '../api'
import { Field, Modal, Page, Toggle, useAction } from '../ui'
import { useApp } from '../App'

const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'], keyHint: 'From console.anthropic.com. Starts with sk-ant-.', baseHint: 'Leave empty unless you use a proxy.' },
  openai: { label: 'OpenAI-compatible', models: [], keyHint: 'Any provider with an OpenAI-style API: OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio…', baseHint: 'For example https://api.openai.com/v1 or http://localhost:11434/v1' },
} as const
const TABS = [['persona', 'Persona'], ['behavior', 'When it replies'], ['tools', 'Tools'], ['training', 'Training'], ['logs', 'Logs'], ['model', 'Model']] as const
const ROLE_TEMPLATE = `You are the first line of support for [Company]. [Company] sells [what you sell] to [who buys it].

How to work:
- Answer only from the knowledge hub. If the answer is not there, say you will check with the team and hand off.
- Create a ticket for bugs, complaints and anything a teammate must follow up.
- Leave a private note when a teammate needs context.

Team:
- [Name] handles billing and refunds
- [Name] handles sales, pricing and demos`

export default function Agent() {
  const { numbers, refresh, me } = useApp()
  const run = useAction()
  const saved = useData('/ai/settings')
  const personalities = useData<any[]>('/ai/personalities').data || []
  const [s, setS] = useState<any>(null)
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('persona')
  useEffect(() => { if (saved.data && !s) setS(saved.data) }, [saved.data, s])
  if (!s) return <Page title="AI Agent">{null}</Page>
  const p = PROVIDERS[s.provider as keyof typeof PROVIDERS]
  const admin = me.role === 'admin'
  const set = (patch: any) => setS({ ...s, ...patch })
  const save = async () => { const r = await run(() => api('PUT', '/ai/settings', s), 'AI agent settings saved'); if (r) { setS(r); saved.reload(); refresh() } }
  const SaveBar = () => (admin ? <button className="btn btn-primary" onClick={save}>Save settings</button> : <p className="text-xs text-slate-500">Only admins can change these settings.</p>)

  return (
    <Page title="AI Agent" subtitle="An assistant that answers customers from your knowledge, uses your tools, and hands off to your team. Shape who it is, when it speaks and what it can do.">
      {!saved.data?.has_key && <button onClick={() => setTab('model')} className="mb-4 block w-full cursor-pointer rounded-lg bg-amber-50 px-3 py-2 text-left text-sm text-amber-900">The agent needs a model before it can reply. <b>Add your API key under Model.</b></button>}
      <div className="mb-4 flex flex-wrap gap-1 border-b border-slate-200" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px cursor-pointer border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-700 text-brand-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="space-y-4 lg:col-span-3">
          {tab === 'persona' && (<>
            <div className="card space-y-4 p-5">
              <Field label="Agent name" hint="Shown to your team on every message the agent sends."><input className="input" value={s.agentName} onChange={(e) => set({ agentName: e.target.value })} /></Field>
              <div>
                <div className="label">Personality</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {personalities.map((x) => (
                    <button key={x.key} type="button" aria-pressed={s.personality === x.key} onClick={() => set({ personality: x.key })} className={`cursor-pointer rounded-xl border p-3 text-left ${s.personality === x.key ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <div className="text-sm font-medium">{x.label}</div><div className="mt-0.5 text-xs text-slate-500">{x.style.replace(/^Tone: /, '')}</div>
                    </button>
                  ))}
                </div>
              </div>
              <Field label="Role and instructions" hint="Who the agent is, what your company does, how to escalate, and who on the team owns what. Facts belong in the knowledge hub, not here.">
                <textarea className="input" rows={10} value={s.instructions} onChange={(e) => set({ instructions: e.target.value })} />
              </Field>
              <button className="btn btn-outline" onClick={() => set({ instructions: ROLE_TEMPLATE })}>Start from a template</button>
              <Field label="Restrictions" hint="Hard limits, one per line. These win over everything else, including what a customer asks for.">
                <textarea className="input" rows={4} value={s.restrictions} onChange={(e) => set({ restrictions: e.target.value })} placeholder={'Never offer discounts. Route pricing negotiations to sales.\nYou cannot process refunds. Create a ticket instead.\nNever promise delivery dates.'} />
              </Field>
              <Field label="Message when handing off to a human"><input className="input" value={s.handoffMessage} onChange={(e) => set({ handoffMessage: e.target.value })} /></Field>
              <SaveBar />
            </div>
          </>)}

          {tab === 'behavior' && (<>
            <div className="card p-5">
              <h2 className="font-medium">Numbers</h2>
              <p className="mb-3 text-sm text-slate-500">Switch the agent on per number. Any single chat can override this from the inbox, and chats marked internal are always skipped.</p>
              {numbers.length === 0 && <p className="text-sm text-slate-500">Connect a number first.</p>}
              {numbers.map((n) => (
                <label key={n.id} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">{n.name}
                  <Toggle label={`AI agent on ${n.name}`} checked={n.ai_enabled} onChange={(v) => admin && run(() => api('PATCH', `/numbers/${n.id}`, { ai_enabled: v })).then(refresh)} />
                </label>
              ))}
            </div>
            <div className="card space-y-4 p-5">
              <h2 className="font-medium">Timing</h2>
              <Field label="Active hours"><select className="input" value={s.hours} onChange={(e) => set({ hours: e.target.value })}><option value="always">Always</option><option value="outside">Only outside business hours</option><option value="business">Only during business hours</option></select></Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Wait before replying (seconds)" hint="Gives a teammate the chance to answer first. If one does, the agent stands down."><input className="input" type="number" min={0} max={6000} value={s.responseDelaySeconds} onChange={(e) => set({ responseDelaySeconds: Math.max(0, Number(e.target.value)) })} /></Field>
                <Field label="Stay quiet after a teammate replies (seconds)" hint="While a person is handling the chat, the agent does not interrupt."><input className="input" type="number" min={0} max={86400} value={s.snoozeSeconds} onChange={(e) => set({ snoozeSeconds: Math.max(0, Number(e.target.value)) })} /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm"><Toggle label="Reply in group chats" checked={s.replyInGroups} onChange={(v) => set({ replyInGroups: v })} />Also reply in group chats</label>
            </div>
            <div className="card space-y-4 p-5">
              <h2 className="font-medium">Which messages deserve a reply</h2>
              <p className="text-sm text-slate-500">By default the agent answers every customer message. Add rules in plain language to make it pickier. Each message is then checked against them first (one extra model call per message).</p>
              <Field label="Activation rules (optional)"><textarea className="input" rows={4} value={s.activationRules} onChange={(e) => set({ activationRules: e.target.value })} placeholder={'Do NOT respond to a greeting with no question.\nDo NOT respond to simple acknowledgments like "ok", "thanks", "got it".\nAlways respond when the customer mentions an order number.'} /></Field>
              <SaveBar />
            </div>
          </>)}

          {tab === 'tools' && <Tools s={s} set={set} SaveBar={SaveBar} admin={admin} />}
          {tab === 'training' && <Training s={s} set={set} SaveBar={SaveBar} admin={admin} />}
          {tab === 'logs' && <Logs />}

          {tab === 'model' && (
            <div className="card space-y-4 p-5">
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
              <SaveBar />
            </div>
          )}
        </div>
        <div className="lg:col-span-2"><Playground ready={!!saved.data?.has_key} /></div>
      </div>
    </Page>
  )
}

function Playground({ ready }: { ready: boolean }) {
  const run = useAction()
  const [chat, setChat] = useState<{ role: string; text: string; sources?: string[]; steps?: any[] }[]>([])
  const [msg, setMsg] = useState('')
  const [thinking, setThinking] = useState(false)
  const ask = async () => {
    const text = msg.trim()
    if (!text) return
    const next = [...chat, { role: 'user', text }]
    setMsg(''); setChat(next); setThinking(true)
    const r = await run(() => api('POST', '/ai/test', { messages: next.map((m) => ({ role: m.role, text: m.text })) }))
    setThinking(false)
    if (r) setChat([...next, { role: 'assistant', text: r.text, sources: r.sources, steps: r.steps }])
  }
  return (
    <div className="card sticky top-4 flex h-[34rem] flex-col">
      <div className="flex items-start justify-between border-b border-slate-200 px-4 py-3">
        <div><div className="flex items-center gap-2 font-medium"><Bot size={16} />Try it</div><div className="text-xs text-slate-500">Chat as a customer would. Uses your saved persona and knowledge. Nothing is sent to WhatsApp.</div></div>
        {chat.length > 0 && <button className="btn btn-ghost !text-xs" onClick={() => setChat([])}>Reset</button>}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {chat.length === 0 && <p className="text-sm text-slate-400">{ready ? 'Type a question below.' : 'Add and save an API key under Model first.'}</p>}
        {chat.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : ''}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-1.5 text-sm ${m.role === 'user' ? 'bg-[#d9fdd3]' : 'bg-slate-100'}`}>
              <div className="whitespace-pre-wrap">{m.text || '(no reply)'}</div>
              {!!m.steps?.length && <div className="mt-1 text-xs text-slate-500">Did: {m.steps.map((x) => x.tool.replace(/_/g, ' ')).join(', ')}</div>}
              {!!m.sources?.length && <div className="text-xs text-slate-500">Used: {m.sources.join(', ')}</div>}
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
  )
}

function Tools({ s, set, SaveBar, admin }: any) {
  const run = useAction()
  const custom = useData<any[]>('/ai/tools')
  const servers = useData<any[]>('/mcp-servers')
  const [editing, setEditing] = useState<any>(null)
  const [srv, setSrv] = useState({ name: '', url: '', token: '' })
  const [probe, setProbe] = useState<Record<string, any>>({})
  const test = async (m: any) => { const r = await run(() => api('POST', `/mcp-servers/${m.id}/test`, {})); if (r) setProbe((p) => ({ ...p, [m.id]: r })) }
  return (<>
    <div className="card space-y-3 p-5">
      <h2 className="font-medium">Built-in abilities</h2>
      {([['allowSend', 'Send messages to customers', 'Off makes the agent a silent assistant: it drafts replies as private notes for your team instead of sending them.'], ['allowTickets', 'Create tickets', 'For issues that need follow-up.'], ['allowNotes', 'Write private notes', 'To give teammates context when it escalates.']] as const).map(([k, label, hint]) => (
        <label key={k} className="flex items-start gap-3 text-sm"><Toggle label={label} checked={s[k]} onChange={(v) => set({ [k]: v })} /><span><span className="font-medium">{label}</span><span className="block text-xs text-slate-500">{hint}</span></span></label>
      ))}
      <p className="text-xs text-slate-500">It can always search the knowledge hub, label the chat and hand off to a human.</p>
      <SaveBar />
    </div>

    <div className="card p-5">
      <div className="flex items-center justify-between"><h2 className="font-medium">Custom tools</h2>{admin && <button className="btn btn-outline" onClick={() => setEditing({ name: '', description: '', method: 'GET', url: '', auth: { type: 'none' }, params: [] })}><Plus size={14} />Add tool</button>}</div>
      <p className="mb-3 text-sm text-slate-500">Point the agent at any HTTP API: look up an order, check stock, book a slot, update your CRM. It collects the parameters from the conversation, calls the API and uses the answer.</p>
      {custom.data?.length === 0 && <p className="text-sm text-slate-400">No custom tools yet.</p>}
      {custom.data?.map((t) => (
        <div key={t.id} className="flex items-center gap-3 border-b border-slate-100 py-2 last:border-0" data-testid="tool-row">
          <Toggle label={`Enable ${t.name}`} checked={t.enabled} onChange={(v) => run(() => api('PUT', `/ai/tools/${t.id}`, { enabled: v })).then(custom.reload)} />
          <div className="min-w-0 flex-1"><div className="truncate font-mono text-sm">{t.name}</div><div className="truncate text-xs text-slate-500">{t.method} {t.url} · {t.description}</div></div>
          {admin && <button className="btn btn-ghost !p-1.5" aria-label={`Edit ${t.name}`} onClick={() => setEditing({ ...t, auth: { ...t.auth } })}><Pencil size={14} /></button>}
          {admin && <button className="btn btn-danger !p-1.5" aria-label={`Delete ${t.name}`} onClick={() => confirm(`Delete tool "${t.name}"?`) && run(() => api('DELETE', `/ai/tools/${t.id}`)).then(custom.reload)}><Trash2 size={14} /></button>}
        </div>
      ))}
    </div>

    <div className="card p-5">
      <h2 className="font-medium">Connectors (MCP servers)</h2>
      <p className="mb-3 text-sm text-slate-500">Connect any MCP server (your knowledge hub, CRM, order system) and choose exactly which of its tools the agent may use. Results are treated as information, never as instructions.</p>
      <div className="space-y-2">
        {servers.data?.map((m) => (
          <div key={m.id} className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center gap-2">
              <Toggle label={`Enable ${m.name}`} checked={m.enabled} onChange={(v) => run(() => api('PATCH', `/mcp-servers/${m.id}`, { enabled: v })).then(servers.reload)} />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{m.name}</div><div className="truncate text-xs text-slate-500">{m.url}</div></div>
              <button className="btn btn-outline !py-1" onClick={() => test(m)}>{probe[m.id] ? 'Refresh' : 'Show tools'}</button>
              {admin && <button className="btn btn-danger !p-1.5" aria-label={`Remove ${m.name}`} onClick={() => run(() => api('DELETE', `/mcp-servers/${m.id}`)).then(servers.reload)}><Trash2 size={14} /></button>}
            </div>
            {probe[m.id] && (probe[m.id].ok ? (
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {probe[m.id].tools.map((t: any) => {
                  const on = !m.disabled_tools.includes(t.name)
                  return <label key={t.name} className="flex items-center gap-2 text-xs" title={t.description}><input type="checkbox" checked={on} disabled={!admin} onChange={() => run(() => api('PATCH', `/mcp-servers/${m.id}`, { disabled_tools: on ? [...m.disabled_tools, t.name] : m.disabled_tools.filter((x: string) => x !== t.name) })).then(servers.reload)} /><span className="truncate font-mono">{t.name}</span></label>
                })}
              </div>
            ) : <div className="mt-2 text-xs text-red-600">Could not connect: {probe[m.id].error}</div>)}
          </div>
        ))}
      </div>
      {admin && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input className="input" placeholder="Name, e.g. Company hub" aria-label="MCP server name" value={srv.name} onChange={(e) => setSrv({ ...srv, name: e.target.value })} />
          <input className="input" placeholder="https://example.com/mcp" aria-label="MCP server URL" value={srv.url} onChange={(e) => setSrv({ ...srv, url: e.target.value })} />
          <input className="input sm:col-span-2" type="password" autoComplete="off" placeholder="Bearer token (optional)" aria-label="MCP server token" value={srv.token} onChange={(e) => setSrv({ ...srv, token: e.target.value })} />
          <button className="btn btn-outline sm:col-span-2" disabled={!srv.name.trim() || !srv.url.trim()} onClick={async () => { const m = await run(() => api('POST', '/mcp-servers', srv), 'Connector added'); if (m) { setSrv({ name: '', url: '', token: '' }); await servers.reload(); test(m) } }}>Add connector</button>
        </div>
      )}
    </div>
    {editing && <ToolEditor tool={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); custom.reload() }} />}
  </>)
}

function ToolEditor({ tool, onClose, onSaved }: { tool: any; onClose: () => void; onSaved: () => void }) {
  const run = useAction()
  const [t, setT] = useState<any>(tool)
  const set = (patch: any) => setT({ ...t, ...patch })
  const setParam = (i: number, patch: any) => set({ params: t.params.map((p: any, j: number) => (j === i ? { ...p, ...patch } : p)) })
  const save = async () => { if (await run(() => api(t.id ? 'PUT' : 'POST', t.id ? `/ai/tools/${t.id}` : '/ai/tools', t), 'Tool saved')) onSaved() }
  return (
    <Modal title={t.id ? 'Edit tool' : 'New custom tool'} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Tool name" hint="Lowercase with underscores, e.g. get_order_status"><input className="input font-mono" value={t.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></Field>
          <Field label="When should the AI use it?"><input className="input" value={t.description} onChange={(e) => set({ description: e.target.value })} placeholder="Look up the delivery status of an order by its order id" /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Method"><select className="input" value={t.method} onChange={(e) => set({ method: e.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => <option key={m}>{m}</option>)}</select></Field>
          <div className="sm:col-span-3"><Field label="URL" hint="Use {name} to place a parameter in the path."><input className="input font-mono" value={t.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://api.example.com/orders/{order_id}" /></Field></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Authentication"><select className="input" value={t.auth.type} onChange={(e) => set({ auth: { type: e.target.value } })}><option value="none">None</option><option value="bearer">Bearer token</option><option value="api_key">API key header</option><option value="basic">Username and password</option></select></Field>
          {t.auth.type === 'bearer' && <div className="sm:col-span-2"><Field label="Token"><input className="input" type="password" autoComplete="off" placeholder={t.auth.has_secret ? 'Saved. Type to replace.' : ''} value={t.auth.token || ''} onChange={(e) => set({ auth: { ...t.auth, token: e.target.value } })} /></Field></div>}
          {t.auth.type === 'api_key' && <><Field label="Header name"><input className="input" value={t.auth.header || ''} placeholder="X-Api-Key" onChange={(e) => set({ auth: { ...t.auth, header: e.target.value } })} /></Field><Field label="Key"><input className="input" type="password" autoComplete="off" placeholder={t.auth.has_secret ? 'Saved. Type to replace.' : ''} value={t.auth.value || ''} onChange={(e) => set({ auth: { ...t.auth, value: e.target.value } })} /></Field></>}
          {t.auth.type === 'basic' && <><Field label="Username"><input className="input" value={t.auth.username || ''} onChange={(e) => set({ auth: { ...t.auth, username: e.target.value } })} /></Field><Field label="Password"><input className="input" type="password" autoComplete="off" placeholder={t.auth.has_secret ? 'Saved. Type to replace.' : ''} value={t.auth.password || ''} onChange={(e) => set({ auth: { ...t.auth, password: e.target.value } })} /></Field></>}
        </div>
        <div>
          <div className="label">Parameters the AI must fill in</div>
          <div className="space-y-2">
            {t.params.map((p: any, i: number) => (
              <div key={i} className="grid items-center gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-12">
                <input className="input font-mono sm:col-span-3" placeholder="name" aria-label="Parameter name" value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} />
                <select className="input sm:col-span-2" aria-label="Parameter type" value={p.type} onChange={(e) => setParam(i, { type: e.target.value })}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Yes/No</option></select>
                <select className="input sm:col-span-2" aria-label="Parameter location" value={p.location} onChange={(e) => setParam(i, { location: e.target.value })}><option value="body">Body</option><option value="query">Query</option><option value="path">Path</option></select>
                <input className="input sm:col-span-3" placeholder="What it is and how to get it" aria-label="Parameter description" value={p.description} onChange={(e) => setParam(i, { description: e.target.value })} />
                <label className="flex items-center gap-1 text-xs sm:col-span-1"><input type="checkbox" checked={p.required} onChange={(e) => setParam(i, { required: e.target.checked })} />Req.</label>
                <button className="btn btn-danger !p-1.5 sm:col-span-1" aria-label="Remove parameter" onClick={() => set({ params: t.params.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="btn btn-outline" onClick={() => set({ params: [...t.params, { name: '', type: 'string', location: t.method === 'GET' ? 'query' : 'body', required: true, description: '' }] })}><Plus size={14} />Add parameter</button>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4"><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!t.name.trim() || !t.description.trim() || !t.url.trim()} onClick={save}>Save tool</button></div>
      </div>
    </Modal>
  )
}

function Training({ s, set, SaveBar, admin }: any) {
  const run = useAction()
  const runs = useData<any[]>('/ai/training')
  const faqs = useData<any[]>('/faqs').data || []
  const [busy, setBusy] = useState(false)
  const waiting = faqs.filter((f) => f.status === 'review').length
  return (<>
    <div className="card p-5">
      <h2 className="font-medium">Three ways to train the agent</h2>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-slate-600">
        <li><b>Write FAQs.</b> A question (with alternative phrasings), the answer, and optional handling instructions. The most precise way to control an answer.</li>
        <li><b>Add documents.</b> Paste text, import web pages or upload PDFs: policies, price lists, SOPs.</li>
        <li><b>Let it learn from your team.</b> Self-training reads the past week of chats your teammates answered and drafts FAQs from their replies.</li>
      </ol>
      <Link to="/knowledge" className="btn btn-outline mt-3">Open the knowledge hub{waiting > 0 ? ` (${waiting} waiting for review)` : ''}</Link>
    </div>
    <div className="card space-y-4 p-5">
      <h2 className="font-medium">Self-training</h2>
      <label className="flex items-start gap-3 text-sm"><Toggle label="Run every week" checked={s.selfTrainWeekly} onChange={(v) => set({ selfTrainWeekly: v })} /><span><span className="font-medium">Run every Sunday</span><span className="block text-xs text-slate-500">Reviews the last 7 days of conversations where a teammate replied.</span></span></label>
      <label className="flex items-start gap-3 text-sm"><Toggle label="Require review" checked={s.selfLearnApproval} onChange={(v) => set({ selfLearnApproval: v })} /><span><span className="font-medium">Require review before use</span><span className="block text-xs text-slate-500">Learned answers wait in the knowledge hub until someone approves them. Turn off to use them immediately.</span></span></label>
      <div className="flex flex-wrap gap-2"><SaveBar />{admin && <button className="btn btn-outline" disabled={busy} onClick={async () => { setBusy(true); const r = await run(() => api('POST', '/ai/training/run', {})); setBusy(false); runs.reload(); if (r) alert(r.status === 'complete' ? `Training finished: ${r.learned} new FAQ${r.learned === 1 ? '' : 's'} from ${r.chats} conversation${r.chats === 1 ? '' : 's'}.` : `Training failed: ${r.error}`) }}>{busy ? 'Training…' : 'Run training now'}</button>}</div>
      {!!runs.data?.length && (
        <table className="w-full text-left text-sm"><thead><tr className="text-xs text-slate-500"><th className="py-1 font-medium">When</th><th className="font-medium">Trigger</th><th className="font-medium">Status</th><th className="font-medium">Chats read</th><th className="font-medium">FAQs learned</th></tr></thead><tbody>
          {runs.data.map((r) => <tr key={r.id} className="border-t border-slate-100"><td className="py-1.5">{dateTime(r.created_at)}</td><td>{r.trigger === 'manual' ? 'Manual' : 'Scheduled'}</td><td className={r.status === 'failed' ? 'text-red-600' : ''} title={r.error || ''}>{r.status === 'complete' ? 'Complete' : r.status === 'failed' ? 'Failed' : 'In progress'}</td><td>{r.chats}</td><td>{r.learned}</td></tr>)}
        </tbody></table>
      )}
    </div>
  </>)
}

function Logs() {
  const logs = useData<any[]>('/ai/logs')
  const KIND: Record<string, [string, string]> = { reply: ['Replied', 'bg-emerald-100 text-emerald-700'], skipped: ['Skipped', 'bg-slate-100 text-slate-600'], error: ['Error', 'bg-red-100 text-red-700'] }
  return (
    <div className="card p-5">
      <div className="mb-3 flex items-center justify-between"><h2 className="font-medium">What the agent did and why</h2><button className="btn btn-outline !py-1" onClick={logs.reload}>Refresh</button></div>
      {logs.data?.length === 0 && <p className="text-sm text-slate-500">Nothing yet. Every reply, skipped message and tool call will be listed here.</p>}
      <div className="space-y-2">
        {logs.data?.map((l) => (
          <div key={l.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><span className={`chip ${KIND[l.kind]?.[1]}`}>{KIND[l.kind]?.[0] || l.kind}</span>{l.chat_id && <Link className="font-medium text-brand-700" to={`/inbox/${l.chat_id}`}>{l.chat_name || 'Chat'}</Link>}<span className="ml-auto text-xs text-slate-400">{dateTime(l.created_at)}</span></div>
            <div className="mt-1 text-slate-500">Customer: {l.input || '–'}</div>
            <div className="whitespace-pre-wrap">{l.output}</div>
            {l.trace.length > 0 && <div className="mt-1 space-y-0.5 text-xs text-slate-500">{l.trace.map((t: any, i: number) => <div key={i} className="truncate" title={t.output}><span className="font-mono text-slate-700">{t.tool}</span>({JSON.stringify(t.input)}) → {t.output}</div>)}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
