import { useState } from 'react'
import { Megaphone, Plus, Trash2 } from 'lucide-react'
import { api, dateTime, useData } from '../api'
import { Empty, Field, Modal, Page, useAction } from '../ui'
import { useApp } from '../App'

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
  const { numbers, labels } = useApp()
  const chats = useData<any[]>('/chats?limit=500').data || []
  const [f, setF] = useState({ name: '', text: '', when: 'now', send_at: '', repeat: 'none' })
  const [picked, setPicked] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [labelId, setLabelId] = useState('')
  const [fromNumber, setFromNumber] = useState('')
  const [onlyPicked, setOnlyPicked] = useState(false)
  const [typed, setTyped] = useState('')
  const [sendFrom, setSendFrom] = useState(numbers[0]?.id || '')
  const [skipped, setSkipped] = useState<any[] | null>(null)

  const needle = q.trim().toLowerCase()
  const shown = chats.filter((c) =>
    (!needle || c.name?.toLowerCase().includes(needle) || (c.phone || '').includes(needle.replace(/\D/g, '') || '\u0000')) &&
    (!kind || c.type === kind) && (!labelId || c.labels.some((l: any) => l.id === labelId)) && (!fromNumber || c.number_id === fromNumber) && (!onlyPicked || picked.includes(c.id)))
  const phones = typed.split(/\n/).map((x) => x.trim()).filter(Boolean)
  const total = picked.length + phones.length
  const allShown = shown.length > 0 && shown.every((c) => picked.includes(c.id))
  const first = chats.find((c) => c.id === picked[0])
  const sample = first?.name || phones[0]?.split(/[,;\t]/)[1]?.trim() || 'Sam'

  const save = async () => {
    const body = { name: f.name, text: f.text, chat_ids: picked, phones, number_id: sendFrom, repeat: f.repeat, send_at: f.when === 'later' ? new Date(f.send_at).toISOString() : undefined }
    const r = await run(() => api('POST', '/scheduled', body), f.when === 'now' ? 'Sending now' : 'Scheduled')
    if (!r) return
    if (r.skipped?.length) setSkipped(r.skipped)
    else onSaved()
  }
  if (skipped) return (
    <Modal title="Sent, with some numbers skipped" onClose={onSaved}>
      <p className="mb-3 text-sm text-slate-600">The message is going out to everyone else. These could not be used:</p>
      <div className="max-h-64 divide-y divide-slate-100 overflow-y-auto text-sm">{skipped.map((x, i) => <div key={i} className="py-1.5"><span className="font-mono">{x.phone}</span> <span className="text-slate-500">· {x.reason}</span></div>)}</div>
      <button className="btn btn-primary mt-4 w-full" onClick={onSaved}>Done</button>
    </Modal>
  )
  return (
    <Modal title="New message" onClose={onClose} wide>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-3">
          <div>
            <div className="label">1. Choose from your chats ({picked.length} selected)</div>
            <input className="input mb-2" placeholder="Search by name or phone number" aria-label="Search recipients" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="mb-2 flex flex-wrap gap-1.5">
              <select className="input !w-auto !py-1 text-xs" aria-label="Chat type" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">People and groups</option><option value="dm">People only</option><option value="group">Groups only</option></select>
              {labels.length > 0 && <select className="input !w-auto !py-1 text-xs" aria-label="Label" value={labelId} onChange={(e) => setLabelId(e.target.value)}><option value="">Any label</option>{labels.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
              {numbers.length > 1 && <select className="input !w-auto !py-1 text-xs" aria-label="Number" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)}><option value="">Any number</option>{numbers.map((n: any) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>}
            </div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <button type="button" className="cursor-pointer font-medium text-brand-700" onClick={() => setPicked(allShown ? picked.filter((p) => !shown.some((c) => c.id === p)) : [...new Set([...picked, ...shown.map((c) => c.id)])])}>{allShown ? 'Unselect' : 'Select'} all {shown.length} shown</button>
              <label className="flex cursor-pointer items-center gap-1 text-slate-500"><input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} />Show selected only</label>
            </div>
            <div className="h-56 overflow-y-auto rounded-lg border border-slate-200" data-testid="recipient-list">
              {shown.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.type === 'group' ? <span className="chip bg-slate-100 text-slate-500">group</span> : c.phone && <span className="shrink-0 text-xs text-slate-400">+{c.phone}</span>}
                </label>
              ))}
              {shown.length === 0 && <div className="p-4 text-center text-sm text-slate-400">{chats.length ? 'No chats match these filters.' : 'No chats yet. Type numbers below instead.'}</div>}
            </div>
          </div>
          <div>
            <div className="label">2. Or type or paste phone numbers ({phones.length})</div>
            <textarea className="input font-mono !text-xs" rows={4} aria-label="Phone numbers" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={'One per line, with country code.\nAdd a name after a comma if you like:\n60123456789, Aisha\n+65 8530 7352'} />
            {phones.length > 0 && (
              <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">Send these from
                <select className="input !w-auto !py-1 text-xs" aria-label="Send from" value={sendFrom} onChange={(e) => setSendFrom(e.target.value)}>{numbers.map((n: any) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>
              </div>
            )}
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Name (only you see this)"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="June promotion" /></Field>
          <Field label="Message" hint="Personalise with {{contact.name}}, {{chat.name}} or any chat property such as {{chat.props.plan}}.">
            <textarea className="input" rows={6} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="Hi {{contact.name}}, …" />
          </Field>
          {f.text.includes('{{') && <div className="rounded-lg bg-[#d9fdd3] px-3 py-2 text-sm whitespace-pre-wrap" data-testid="preview"><div className="mb-0.5 text-xs text-slate-500">Preview for {sample}</div>{f.text.replace(/\{\{\s*(contact|chat)\.name\s*\}\}/g, sample)}</div>}
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
          <button className="btn btn-primary w-full !py-2" disabled={!total || !f.text.trim() || (f.when === 'later' && !f.send_at) || (phones.length > 0 && !sendFrom)} onClick={save}>{f.when === 'now' ? `Send to ${total} recipient${total === 1 ? '' : 's'}` : `Schedule for ${total} recipient${total === 1 ? '' : 's'}`}</button>
          <p className="text-xs text-slate-500">Messages go out one at a time with pauses. Numbers that are not on WhatsApp are skipped and listed for you.</p>
        </div>
      </div>
    </Modal>
  )
}
