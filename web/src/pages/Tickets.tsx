import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MessageSquare, Plus, Ticket, Trash2 } from 'lucide-react'
import { api, timeAgo, useData, useLive } from '../api'
import { Empty, Field, Modal, Page, useAction } from '../ui'
import { useApp } from '../App'

const COLUMNS = [['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']] as const
const PRIORITY: Record<string, string> = { low: 'bg-slate-100 text-slate-600', medium: 'bg-sky-100 text-sky-700', high: 'bg-amber-100 text-amber-800', urgent: 'bg-red-100 text-red-700' }

export default function Tickets() {
  const { users } = useApp()
  const run = useAction()
  const tickets = useData<any[]>('/tickets')
  const [draft, setDraft] = useState<any>(null)
  useLive((e) => { if (e.startsWith('ticket.')) tickets.reload() })
  const update = (id: string, patch: any) => run(() => api('PATCH', `/tickets/${id}`, patch)).then(tickets.reload)

  return (
    <Page title="Tickets" subtitle="Track customer requests to done. Create them from any chat, by automation, by the AI agent, or through the API."
      actions={<button className="btn btn-primary" onClick={() => setDraft({ title: '', description: '', priority: 'medium' })}><Plus size={16} />New ticket</button>}>
      {tickets.data?.length === 0 ? <Empty icon={<Ticket size={22} />} title="No tickets yet" hint="Open a chat and create a ticket from the details panel, or add an automation that creates them from keywords." /> : (
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map(([status, label]) => {
            const items = tickets.data?.filter((t) => t.status === status) || []
            return (
              <div key={status} data-testid={`column-${status}`}>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-600">{label}<span className="rounded-full bg-slate-200 px-1.5 text-xs">{items.length}</span></div>
                <div className="space-y-2">
                  {items.map((t) => (
                    <div key={t.id} className="card p-3 text-sm" data-testid="ticket-card">
                      <div className="flex items-start justify-between gap-2"><div className="font-medium">#{t.seq} {t.title}</div><button className="btn btn-danger !p-1" aria-label={`Delete ticket ${t.seq}`} onClick={() => confirm('Delete this ticket?') && run(() => api('DELETE', `/tickets/${t.id}`)).then(tickets.reload)}><Trash2 size={13} /></button></div>
                      {t.description && <div className="mt-1 line-clamp-2 text-slate-500">{t.description}</div>}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className={`chip ${PRIORITY[t.priority]}`}>{t.priority}</span>
                        {t.chat_id && <Link to={`/inbox/${t.chat_id}`} className="chip bg-slate-100 text-slate-600 hover:bg-slate-200"><MessageSquare size={11} />{t.chat_name}</Link>}
                        <span className="text-xs text-slate-400">{timeAgo(t.created_at)}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-1.5">
                        <select className="rounded border border-slate-200 px-1 py-1 text-xs" aria-label={`Status of ticket ${t.seq}`} value={t.status} onChange={(e) => update(t.id, { status: e.target.value })}>{COLUMNS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                        <select className="rounded border border-slate-200 px-1 py-1 text-xs" aria-label={`Assignee of ticket ${t.seq}`} value={t.assignee_id || ''} onChange={(e) => update(t.id, { assignee_id: e.target.value || null })}><option value="">Unassigned</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
                      </div>
                    </div>
                  ))}
                  {items.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-400">Nothing here</div>}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {draft && (
        <Modal title="New ticket" onClose={() => setDraft(null)}>
          <div className="space-y-3">
            <Field label="Title"><input className="input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus /></Field>
            <Field label="Details"><textarea className="input" rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
            <Field label="Priority"><select className="input" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>{Object.keys(PRIORITY).map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
            <button className="btn btn-primary w-full" disabled={!draft.title.trim()} onClick={async () => { if (await run(() => api('POST', '/tickets', draft), 'Ticket created')) { setDraft(null); tickets.reload() } }}>Create ticket</button>
          </div>
        </Modal>
      )}
    </Page>
  )
}
