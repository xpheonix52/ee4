import { Link } from 'react-router-dom'
import { CheckCircle2, Circle } from 'lucide-react'
import { useData } from '../api'
import { Page } from '../ui'
import { useApp } from '../App'

export default function Home() {
  const { me, numbers, users } = useApp()
  const stats = useData('/analytics').data
  const docs = useData<any[]>('/knowledge').data
  const autos = useData<any[]>('/automations').data
  const ai = useData('/ai/settings').data

  const steps = [
    { done: numbers.length > 0, to: '/numbers', title: 'Connect a WhatsApp number', hint: 'Scan a QR code, or add a sandbox number to try things without a phone.' },
    { done: !!docs?.length, to: '/knowledge', title: 'Add knowledge', hint: 'Paste FAQs or import a web page so the AI agent can answer from it.' },
    { done: !!ai?.has_key, to: '/agent', title: 'Switch on the AI agent', hint: 'Add your model provider key and choose where the agent replies.' },
    { done: !!autos?.length, to: '/automations', title: 'Create an automation', hint: 'Start from a template: auto-replies, ticketing, routing, CRM sync.' },
    { done: users.length > 1, to: '/settings', title: 'Invite your team', hint: 'Give teammates their own login to the shared inbox.' },
  ]
  const remaining = steps.filter((s) => !s.done).length
  const max = Math.max(1, ...(stats?.by_day || []).map((d: any) => d.in + d.out))
  const fmt = (s: number | null) => (s == null ? '–' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`)

  return (
    <Page title={`Hi ${me?.name?.split(' ')[0] || 'there'}`} subtitle="Here is what is happening across your WhatsApp numbers.">
      {remaining > 0 && (
        <div className="card mb-6 p-5">
          <div className="mb-3 font-medium">Get set up · {steps.length - remaining} of {steps.length} done</div>
          <div className="space-y-1">
            {steps.map((s) => (
              <Link key={s.to + s.title} to={s.to} className="flex items-start gap-3 rounded-lg p-2 hover:bg-slate-50">
                {s.done ? <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-brand-600" /> : <Circle size={20} className="mt-0.5 shrink-0 text-slate-300" />}
                <div>
                  <div className={`text-sm font-medium ${s.done ? 'text-slate-400 line-through' : ''}`}>{s.title}</div>
                  {!s.done && <div className="text-sm text-slate-500">{s.hint}</div>}
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Open chats', stats?.open_chats, '/inbox'], ['Unread', stats?.unread_chats, '/inbox'], ['Unassigned', stats?.unassigned_chats, '/inbox'], ['Open tickets', stats?.open_tickets, '/tickets'],
          ['Received (7d)', stats?.messages_in], ['Sent (7d)', stats?.messages_out], ['Median reply time', stats ? fmt(stats.median_response_seconds) : undefined], ['Automation runs (7d)', stats?.automations_run, '/automations'],
        ].map(([label, value, to]) => {
          const body = (<><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value ?? '–'}</div></>)
          return to ? <Link key={label as string} to={to as string} className="card p-4 hover:border-brand-500">{body}</Link> : <div key={label as string} className="card p-4">{body}</div>
        })}
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div className="font-medium">Messages, last 7 days</div>
            <div className="flex gap-3 text-xs text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-400" />Received</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-600" />Sent</span></div>
          </div>
          <div className="flex h-36 items-end gap-2">
            {(stats?.by_day || []).map((d: any) => (
              <div key={d.date} className="flex flex-1 flex-col items-center gap-1" title={`${d.date}: ${d.in} received, ${d.out} sent`}>
                <div className="flex h-28 w-full items-end justify-center gap-0.5">
                  <div className="w-1/2 max-w-5 rounded-t bg-slate-400" style={{ height: `${(d.in / max) * 100}%` }} />
                  <div className="w-1/2 max-w-5 rounded-t bg-brand-600" style={{ height: `${(d.out / max) * 100}%` }} />
                </div>
                <div className="text-xs text-slate-400">{new Date(d.date).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card p-5">
          <div className="mb-3 font-medium">Who replied (7 days)</div>
          {stats?.by_sender?.length ? stats.by_sender.map((s: any) => (
            <div key={s.name} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0"><span>{s.name}</span><span className="font-medium tabular-nums">{s.count}</span></div>
          )) : <div className="text-sm text-slate-500">No replies yet.</div>}
        </div>
      </div>
    </Page>
  )
}
