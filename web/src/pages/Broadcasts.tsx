import { useState } from 'react'
import { Megaphone, Plus, Trash2 } from 'lucide-react'
import { api, dateTime, useData } from '../api'
import { Empty, Field, Modal, Page, useAction } from '../ui'

export default function Broadcasts() {
  const list = useData<any[]>('/scheduled')
  const settings = useData('/settings').data
  const run = useAction()
  const [open, setOpen] = useState(false)
  return (
    <Page title="Broadcasts & scheduled messages" subtitle="Send one message to many chats, now or later, once or on repeat. Messages go out one at a time with human-like pauses to protect your numbers."
      actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} />New message</button>}>
      {settings && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">Safety limits: {Math.round(settings.sending.broadcastMinDelayMs / 1000)} to {Math.round(settings.sending.broadcastMaxDelayMs / 1000)} seconds between recipients, up to {settings.sending.broadcastDailyLimit} broadcast messages per number per day. Only message people who expect to hear from you. Change limits in Settings.</p>}
      {list.data?.length === 0 ? <Empty icon={<Megaphone size={22} />} title="Nothing scheduled" hint="Announce something to several chats or groups, or set up a recurring reminder." action={<button className="btn btn-primary" onClick={() => setOpen(true)}>New message</button>} /> : (
        <div className="card divide-y divide-slate-100">
          {list.data?.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3" data-testid="scheduled-row">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{s.name || s.text}</div>
                <div className="truncate text-sm text-slate-500">{s.chat_ids.length} chat{s.chat_ids.length === 1 ? '' : 's'} · {s.status === 'sent' ? 'Sent' : 'Sends'} {dateTime(s.send_at)}{s.repeat !== 'none' ? ` · repeats ${s.repeat}` : ''}</div>
              </div>
              <span className={`chip ${s.status === 'sent' ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'}`}>{s.status === 'sent' ? 'Sent' : 'Scheduled'}</span>
              <button className="btn btn-danger !p-1.5" aria-label="Delete" onClick={() => run(() => api('DELETE', `/scheduled/${s.id}`)).then(list.reload)}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
      {open && <Composer onClose={() => setOpen(false)} onSaved={() => { setOpen(false); list.reload() }} />}
    </Page>
  )
}

function Composer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const run = useAction()
  const chats = useData<any[]>('/chats?limit=500').data || []
  const [f, setF] = useState({ name: '', text: '', when: 'now', send_at: '', repeat: 'none' })
  const [picked, setPicked] = useState<string[]>([])
  const [q, setQ] = useState('')
  const shown = chats.filter((c) => c.name?.toLowerCase().includes(q.toLowerCase()))
  const save = async () => {
    const body = { name: f.name, text: f.text, chat_ids: picked, repeat: f.repeat, send_at: f.when === 'later' ? new Date(f.send_at).toISOString() : undefined }
    if (await run(() => api('POST', '/scheduled', body), f.when === 'now' ? 'Sending now' : 'Scheduled')) onSaved()
  }
  return (
    <Modal title="New message" onClose={onClose} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="label">Send to ({picked.length} selected)</div>
          <input className="input mb-2" placeholder="Search chats" aria-label="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="h-64 overflow-y-auto rounded-lg border border-slate-200">
            {shown.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                <span className="truncate">{c.name}</span>{c.type === 'group' && <span className="chip bg-slate-100 text-slate-500">group</span>}
              </label>
            ))}
            {shown.length === 0 && <div className="p-4 text-center text-sm text-slate-400">No chats to pick from yet.</div>}
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Name (only you see this)"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="June promotion" /></Field>
          <Field label="Message"><textarea className="input" rows={5} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" checked={f.when === 'now'} onChange={() => setF({ ...f, when: 'now' })} />Send now</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={f.when === 'later'} onChange={() => setF({ ...f, when: 'later' })} />Schedule</label>
          </div>
          {f.when === 'later' && (
            <div className="grid grid-cols-2 gap-2">
              <input type="datetime-local" className="input" aria-label="Send at" value={f.send_at} onChange={(e) => setF({ ...f, send_at: e.target.value })} />
              <select className="input" aria-label="Repeat" value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value })}><option value="none">Does not repeat</option><option value="daily">Every day</option><option value="weekly">Every week</option></select>
            </div>
          )}
          <button className="btn btn-primary w-full" disabled={!picked.length || !f.text.trim() || (f.when === 'later' && !f.send_at)} onClick={save}>{f.when === 'now' ? `Send to ${picked.length} chat${picked.length === 1 ? '' : 's'}` : 'Schedule'}</button>
        </div>
      </div>
    </Modal>
  )
}
