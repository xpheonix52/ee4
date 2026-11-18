import { useState } from 'react'
import { useData } from '../api'
import { Page } from '../ui'

const dur = (s: number | null) => (s == null ? '–' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`)

export default function Analytics() {
  const [days, setDays] = useState(7)
  const a = useData(`/analytics?days=${days}`).data
  const max = Math.max(1, ...(a?.by_day || []).map((d: any) => d.in + d.out))
  const tiles: [string, any][] = a ? [
    ['Messages received', a.messages_in], ['Messages sent', a.messages_out], ['Median reply time', dur(a.median_response_seconds)], ['Flagged, awaiting reply', a.flagged_messages],
    ['Open chats', a.open_chats], ['Unassigned chats', a.unassigned_chats], ['Open tickets', a.open_tickets], ['Automation runs', a.automations_run],
  ] : []
  return (
    <Page title="Analytics" subtitle="How fast your team answers, who is carrying the load, and where tickets stand."
      actions={<select className="input !w-auto" aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([label, value]) => <div key={label} className="card p-4"><div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value ?? '–'}</div></div>)}
      </div>

      <div className="card mt-4 p-5">
        <div className="mb-4 flex items-center justify-between"><h2 className="font-medium">Messages per day</h2><div className="flex gap-3 text-xs text-slate-500"><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-400" />Received</span><span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-brand-600" />Sent</span></div></div>
        <div className="flex h-36 items-end gap-px sm:gap-1">
          {(a?.by_day || []).map((d: any) => (
            <div key={d.date} className="flex h-full flex-1 items-end justify-center gap-px" title={`${d.date}: ${d.in} received, ${d.out} sent`}>
              <div className="w-1/2 max-w-4 rounded-t bg-slate-400" style={{ height: `${(d.in / max) * 100}%` }} />
              <div className="w-1/2 max-w-4 rounded-t bg-brand-600" style={{ height: `${(d.out / max) * 100}%` }} />
            </div>
          ))}
        </div>
      </div>

      <div className="card mt-4 overflow-x-auto p-5">
        <h2 className="mb-3 font-medium">Team</h2>
        <table className="w-full min-w-[36rem] text-left text-sm" data-testid="team-table">
          <thead><tr className="text-xs text-slate-500"><th className="py-1 font-medium">Teammate</th><th className="font-medium">Messages sent</th><th className="font-medium">Chats handled</th><th className="font-medium">Avg. reply time</th><th className="font-medium">Open chats</th><th className="font-medium">Tickets open</th><th className="font-medium">Tickets resolved</th></tr></thead>
          <tbody>
            {a?.team.map((t: any) => <tr key={t.id} className="border-t border-slate-100 tabular-nums"><td className="py-2 font-medium">{t.name}</td><td>{t.sent}</td><td>{t.chats}</td><td>{dur(t.avg_response_seconds)}</td><td>{t.open_chats}</td><td>{t.tickets_open}</td><td>{t.tickets_resolved}</td></tr>)}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-slate-400">Reply time is measured from a customer's first unanswered message to the teammate's reply.</p>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="card p-5">
          <h2 className="mb-3 font-medium">Tickets (all time)</h2>
          {a && [['Total', a.tickets.total], ['Open', a.tickets.open], ['In progress', a.tickets.in_progress], ['Resolved', a.tickets.resolved], ['Unassigned and unresolved', a.tickets.unassigned], ['Average time to resolve', dur(a.tickets.avg_resolution_seconds)]].map(([k, v]) => <div key={k} className="flex justify-between border-b border-slate-100 py-2 text-sm last:border-0"><span>{k}</span><span className="font-medium tabular-nums">{v}</span></div>)}
        </div>
        <div className="card p-5">
          <h2 className="mb-3 font-medium">Who replied</h2>
          {a?.by_sender?.length ? a.by_sender.map((s: any) => <div key={s.name} className="flex justify-between border-b border-slate-100 py-2 text-sm last:border-0"><span>{s.name}</span><span className="font-medium tabular-nums">{s.count}</span></div>) : <div className="text-sm text-slate-500">No replies in this period.</div>}
        </div>
      </div>
    </Page>
  )
}
