import { useEffect, useRef, useState } from 'react'
import { Send, Sparkles } from 'lucide-react'
import { api } from '../api'
import { Page, useAction } from '../ui'

const IDEAS = [
  'Which open chats have been waiting longest for a reply?',
  'Summarize what customers asked about most this week',
  'Label every open chat that mentions "refund" as Billing',
  'What questions do customers ask that the knowledge hub cannot answer yet?',
  'Create an automation that tags chats mentioning "invoice" and assigns them to me',
  'List urgent tickets and who owns them',
]

export default function Assistant() {
  const run = useAction()
  const [chat, setChat] = useState<{ role: string; text: string; steps?: any[] }[]>([])
  const [msg, setMsg] = useState('')
  const [thinking, setThinking] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [chat.length, thinking])
  const ask = async (text: string) => {
    if (!text.trim() || thinking) return
    const next = [...chat, { role: 'user', text: text.trim() }]
    setMsg(''); setChat(next); setThinking(true)
    const r = await run(() => api('POST', '/assistant', { messages: next.map((m) => ({ role: m.role, text: m.text })) }))
    setThinking(false)
    if (r) setChat([...next, { role: 'assistant', text: r.text, steps: r.steps }])
  }
  return (
    <Page title="Assistant" subtitle="Ask in plain language and it works across your whole workspace: find chats, update labels and tickets in bulk, audit the knowledge hub, build automations. It uses the same tools as the MCP server.">
      <div className="card flex h-[calc(100vh-14rem)] min-h-96 flex-col">
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {chat.length === 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {IDEAS.map((i) => <button key={i} onClick={() => ask(i)} className="cursor-pointer rounded-xl border border-slate-200 p-3 text-left text-sm hover:border-brand-600 hover:bg-brand-50"><Sparkles size={14} className="mr-1.5 inline text-brand-700" />{i}</button>)}
            </div>
          )}
          {chat.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : ''}`}>
              <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${m.role === 'user' ? 'bg-brand-700 text-white' : 'bg-slate-100'}`}>
                <div className="whitespace-pre-wrap">{m.text || '(no answer)'}</div>
                {!!m.steps?.length && <div className="mt-1.5 border-t border-slate-200 pt-1.5 text-xs text-slate-500">Used {m.steps.length} tool call{m.steps.length === 1 ? '' : 's'}: {[...new Set(m.steps.map((s) => s.tool.replace(/_/g, ' ')))].join(', ')}</div>}
              </div>
            </div>
          ))}
          {thinking && <div className="text-sm text-slate-400">Working on it…</div>}
          <div ref={end} />
        </div>
        <div className="flex gap-2 border-t border-slate-200 p-3">
          <input className="input" placeholder="Ask the assistant to find or change something" aria-label="Ask the assistant" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask(msg)} />
          <button className="btn btn-primary !p-2" aria-label="Send to assistant" disabled={thinking || !msg.trim()} onClick={() => ask(msg)}><Send size={16} /></button>
        </div>
      </div>
    </Page>
  )
}
