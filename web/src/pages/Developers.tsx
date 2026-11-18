import { useState } from 'react'
import { KeyRound, Trash2, Webhook } from 'lucide-react'
import { api, dateTime, timeAgo, useData } from '../api'
import { CopyText, Modal, Page, useAction } from '../ui'
import { useApp } from '../App'

const EVENTS = ['message.received', 'message.sent', 'message.updated', 'chat.created', 'chat.updated', 'ticket.created', 'ticket.updated', 'number.status']
const ENDPOINTS: [string, string, string][] = [
  ['GET', '/numbers', 'List connected numbers'], ['GET', '/chats?q=&unread=true&assignee=&label=', 'List and filter chats'], ['GET', '/chats/:id/messages', 'Read a chat'],
  ['POST', '/messages', 'Send to a phone: {number_id, to, text}'], ['POST', '/chats/:id/messages', 'Reply in a chat: {text} or a multipart file'], ['POST', '/chats/:id/notes', 'Add a private note'],
  ['PATCH', '/chats/:id', 'Assign, close, set properties, switch the AI agent: {assignee_id, status, ai_mode, props, internal}'], ['POST', '/chats/:id/labels', 'Add a label: {label}'],
  ['GET · POST · PATCH', '/tickets', 'Manage tickets'], ['GET · POST · PUT · DELETE', '/automations', 'Manage automations'], ['POST', '/hooks/:id/:token', 'Trigger a webhook automation (no key needed)'],
  ['GET · POST', '/knowledge', 'Manage knowledge: {title, content} or {url}'], ['GET', '/knowledge/search?q=', 'Search knowledge'], ['GET · POST · PUT · DELETE', '/faqs', 'Train the agent: {questions[], answer, instructions}'], ['GET · POST', '/ai/tools', 'Custom HTTP tools for the agent'], ['POST', '/ai/training/run', 'Run self-training now'], ['POST', '/assistant', 'Ask the workspace assistant: {message}'], ['GET', '/export/chats.csv', 'Export chats, tickets or messages'], ['POST', '/scheduled', 'Schedule or broadcast: {chat_ids, text, send_at, repeat}'],
  ['GET', '/events', 'Live event stream (Server-Sent Events)'], ['GET', '/analytics', '7-day stats'],
]

export default function Developers() {
  const { me, numbers } = useApp()
  const run = useAction()
  const keys = useData<any[]>(me.role === 'admin' ? '/api-keys' : null)
  const hooks = useData<any[]>(me.role === 'admin' ? '/webhooks' : null)
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<any>(null)
  const [hook, setHook] = useState({ url: '', events: ['*'] as string[] })
  const [log, setLog] = useState<any>(null)
  const base = location.origin
  const key = fresh?.key || 'YOUR_API_KEY'
  if (me.role !== 'admin') return <Page title="API & MCP"><p className="text-sm text-slate-500">Only admins can manage API keys and webhooks.</p></Page>

  return (
    <Page title="API & MCP" subtitle="Everything in Switchboard is available to your own code and to AI assistants. One API key works for the REST API and the MCP server.">
      <div className="space-y-4">
        <section className="card p-5">
          <h2 className="flex items-center gap-2 font-medium"><KeyRound size={16} />API keys</h2>
          <div className="mt-3 flex gap-2">
            <input className="input" placeholder="Key name, e.g. Zapier or Claude" aria-label="API key name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn btn-primary" disabled={!name.trim()} onClick={async () => { const k = await run(() => api('POST', '/api-keys', { name })); if (k) { setFresh(k); setName(''); keys.reload() } }}>Create key</button>
          </div>
          {fresh && <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"><div className="mb-1 text-sm font-medium text-emerald-900">Copy this key now. It will not be shown again.</div><CopyText text={fresh.key} label="Copy API key" /></div>}
          <div className="mt-3 divide-y divide-slate-100">
            {keys.data?.map((k) => (
              <div key={k.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="flex-1 font-medium">{k.name}</span><code className="text-xs text-slate-500">{k.prefix}…</code>
                <span className="text-xs text-slate-400">{k.last_used_at ? `used ${timeAgo(k.last_used_at)} ago` : 'never used'}</span>
                <button className="btn btn-danger !p-1.5" aria-label={`Revoke ${k.name}`} onClick={() => confirm(`Revoke "${k.name}"? Anything using it will stop working.`) && run(() => api('DELETE', `/api-keys/${k.id}`)).then(keys.reload)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </section>

        <section className="card space-y-3 p-5">
          <h2 className="font-medium">MCP server</h2>
          <p className="text-sm text-slate-500">Let Claude, ChatGPT, Cursor or any MCP client read chats, send WhatsApp messages, manage tickets, search knowledge and build automations for you.</p>
          <div><div className="label">Server URL (Streamable HTTP)</div><CopyText text={`${base}/mcp`} /></div>
          <div><div className="label">Claude Code</div><CopyText text={`claude mcp add --transport http switchboard ${base}/mcp --header "Authorization: Bearer ${key}"`} /></div>
          <div><div className="label">Clients that only accept a URL</div><CopyText text={`${base}/mcp?key=${key}`} /></div>
          <div><div className="label">JSON config (Cursor, Claude Desktop and others)</div><CopyText text={JSON.stringify({ mcpServers: { switchboard: { type: 'http', url: `${base}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)} /></div>
        </section>

        <section className="card space-y-3 p-5">
          <h2 className="font-medium">REST API</h2>
          <p className="text-sm text-slate-500">Base URL <code className="rounded bg-slate-100 px-1">{base}/api/v1</code>. Send <code className="rounded bg-slate-100 px-1">Authorization: Bearer &lt;key&gt;</code> with JSON bodies.</p>
          <CopyText text={`curl -X POST ${base}/api/v1/messages \\\n  -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\\n  -d '{"number_id": "${numbers[0]?.id || 'num_…'}", "to": "14155550123", "text": "Hello from the API"}'`} />
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><tbody>
            {ENDPOINTS.map(([m, p, d]) => <tr key={m + p} className="border-t border-slate-100"><td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap text-brand-700">{m}</td><td className="py-1.5 pr-3 font-mono text-xs whitespace-nowrap">{p}</td><td className="py-1.5 text-slate-600">{d}</td></tr>)}
          </tbody></table></div>
        </section>

        <section className="card p-5">
          <h2 className="flex items-center gap-2 font-medium"><Webhook size={16} />Webhooks</h2>
          <p className="mt-1 text-sm text-slate-500">Get a signed POST at your URL whenever something happens. Verify the <code className="rounded bg-slate-100 px-1">X-Switchboard-Signature</code> header: HMAC-SHA256 of the raw body with the webhook secret.</p>
          <div className="mt-3 space-y-2">
            <input className="input" placeholder="https://your-app.com/webhooks/whatsapp" aria-label="Webhook URL" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} />
            <div className="flex flex-wrap gap-1.5">
              {['*', ...EVENTS].map((e) => {
                const on = hook.events.includes(e)
                return <button key={e} type="button" aria-pressed={on} onClick={() => setHook({ ...hook, events: e === '*' ? ['*'] : on ? hook.events.filter((x) => x !== e) : [...hook.events.filter((x) => x !== '*'), e] })} className={`chip cursor-pointer ${on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600'}`}>{e === '*' ? 'All events' : e}</button>
              })}
            </div>
            <button className="btn btn-primary" disabled={!hook.url.trim() || !hook.events.length} onClick={async () => { if (await run(() => api('POST', '/webhooks', hook), 'Webhook added')) { setHook({ url: '', events: ['*'] }); hooks.reload() } }}>Add webhook</button>
          </div>
          <div className="mt-4 space-y-2">
            {hooks.data?.map((w) => (
              <div key={w.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{w.url}</span>
                  <button className="btn btn-outline !py-1" onClick={async () => setLog({ hook: w, rows: (await run(() => api('GET', `/webhooks/${w.id}/deliveries`))) || [] })}>Deliveries</button>
                  <button className="btn btn-danger !p-1.5" aria-label="Delete webhook" onClick={() => run(() => api('DELETE', `/webhooks/${w.id}`)).then(hooks.reload)}><Trash2 size={14} /></button></div>
                <div className="mt-1 text-xs text-slate-500">{w.events.includes('*') ? 'All events' : w.events.join(', ')}</div>
                <div className="mt-2"><CopyText text={w.secret} label="Copy secret" /></div>
              </div>
            ))}
          </div>
        </section>
      </div>
      {log && (
        <Modal title="Recent deliveries" onClose={() => setLog(null)} wide>
          {log.rows.length === 0 && <p className="text-sm text-slate-500">Nothing delivered yet.</p>}
          {log.rows.map((d: any) => <div key={d.id} className="flex items-center gap-3 border-b border-slate-100 py-1.5 text-sm"><span className={`chip ${d.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{d.ok ? d.status_code : d.error || 'failed'}</span><span className="flex-1 font-mono text-xs">{d.event}</span><span className="text-xs text-slate-400">{d.attempts} attempt{d.attempts === 1 ? '' : 's'} · {dateTime(d.created_at)}</span></div>)}
        </Modal>
      )}
    </Page>
  )
}
