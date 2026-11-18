import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { api, useData } from '../api'
import { Field, Page, Toggle, useAction } from '../ui'
import { useApp } from '../App'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function Settings() {
  const { me, users, labels, refresh } = useApp()
  const run = useAction()
  const saved = useData('/settings')
  const quick = useData<any[]>('/quick-replies')
  const [s, setS] = useState<any>(null)
  const [user, setUser] = useState({ name: '', email: '', password: '', role: 'agent' })
  const [label, setLabel] = useState({ name: '', color: '#2563eb' })
  const [qr, setQr] = useState({ shortcut: '', text: '' })
  useEffect(() => { if (saved.data && !s) setS(saved.data) }, [saved.data, s])
  const admin = me.role === 'admin'
  if (!s) return <Page title="Settings">{null}</Page>
  const upd = (group: string, patch: any) => setS({ ...s, [group]: { ...s[group], ...patch } })
  const save = () => run(() => api('PUT', '/settings', s), 'Settings saved').then((r) => r && refresh())
  const secs = (k: string) => ({ value: Math.round(s.sending[k] / 1000), onChange: (e: any) => upd('sending', { [k]: Math.max(0, Number(e.target.value)) * 1000 }) })

  return (
    <Page title="Settings">
      <div className="space-y-4">
        <section className="card space-y-4 p-5">
          <h2 className="font-medium">Workspace</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Team or company name"><input className="input" disabled={!admin} value={s.workspace.name} onChange={(e) => upd('workspace', { name: e.target.value })} /></Field>
            <Field label="Time zone (hours from UTC)" hint="Used for business hours and scheduled automations."><input className="input" type="number" step="0.25" disabled={!admin} value={s.workspace.timezoneOffsetMinutes / 60} onChange={(e) => upd('workspace', { timezoneOffsetMinutes: Math.round(Number(e.target.value) * 60) })} /></Field>
          </div>
          <div>
            <div className="label">Business hours</div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex gap-1">{DAYS.map((d, i) => { const on = s.businessHours.days.includes(i); return <button key={d} type="button" disabled={!admin} aria-pressed={on} onClick={() => upd('businessHours', { days: on ? s.businessHours.days.filter((x: number) => x !== i) : [...s.businessHours.days, i] })} className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium ${on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-500'}`}>{d}</button> })}</div>
              <input type="time" className="input !w-28" aria-label="Opens at" disabled={!admin} value={s.businessHours.start} onChange={(e) => upd('businessHours', { start: e.target.value })} /><span className="text-slate-400">to</span>
              <input type="time" className="input !w-28" aria-label="Closes at" disabled={!admin} value={s.businessHours.end} onChange={(e) => upd('businessHours', { end: e.target.value })} />
            </div>
            <p className="mt-1 text-xs text-slate-500">Automations can check "Within business hours", for example to send an away message.</p>
          </div>
        </section>

        <section className="card space-y-3 p-5">
          <h2 className="font-medium">Sending safety</h2>
          <p className="text-sm text-slate-500">WhatsApp can restrict numbers that behave like bots. These pauses make automated sending look human. Messages you type yourself always send instantly.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Automation & AI delay (seconds)"><div className="flex items-center gap-1"><input className="input" type="number" min={0} disabled={!admin} {...secs('minDelayMs')} aria-label="Minimum delay" /><span className="text-slate-400">to</span><input className="input" type="number" min={0} disabled={!admin} {...secs('maxDelayMs')} aria-label="Maximum delay" /></div></Field>
            <Field label="Broadcast gap (seconds)"><div className="flex items-center gap-1"><input className="input" type="number" min={0} disabled={!admin} {...secs('broadcastMinDelayMs')} aria-label="Minimum broadcast gap" /><span className="text-slate-400">to</span><input className="input" type="number" min={0} disabled={!admin} {...secs('broadcastMaxDelayMs')} aria-label="Maximum broadcast gap" /></div></Field>
            <Field label="Broadcast messages per number per day"><input className="input" type="number" min={1} disabled={!admin} value={s.sending.broadcastDailyLimit} onChange={(e) => upd('sending', { broadcastDailyLimit: Number(e.target.value) })} /></Field>
          </div>
          {admin && <button className="btn btn-primary" onClick={save}>Save settings</button>}
        </section>

        <section className="card p-5">
          <h2 className="font-medium">Team</h2>
          <div className="mt-2 divide-y divide-slate-100">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1"><span className="font-medium">{u.name}</span>{u.id === me.id && <span className="text-slate-400"> (you)</span>}<div className="truncate text-xs text-slate-500">{u.email}</div></div>
                <select className="rounded border border-slate-200 px-1 py-1 text-xs" aria-label={`Role of ${u.name}`} disabled={!admin} value={u.role} onChange={(e) => run(() => api('PATCH', `/users/${u.id}`, { role: e.target.value })).then(refresh)}><option value="admin">Admin</option><option value="agent">Agent</option></select>
                {admin && u.id !== me.id && <button className="btn btn-danger !p-1.5" aria-label={`Remove ${u.name}`} onClick={() => confirm(`Remove ${u.name}?`) && run(() => api('DELETE', `/users/${u.id}`)).then(refresh)}><Trash2 size={14} /></button>}
              </div>
            ))}
          </div>
          {admin && (
            <div className="mt-3 grid gap-2 sm:grid-cols-5">
              <input className="input" placeholder="Name" aria-label="Teammate name" value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value })} />
              <input className="input" placeholder="Email" aria-label="Teammate email" type="email" value={user.email} onChange={(e) => setUser({ ...user, email: e.target.value })} />
              <input className="input" placeholder="Temporary password" aria-label="Temporary password" value={user.password} onChange={(e) => setUser({ ...user, password: e.target.value })} />
              <select className="input" aria-label="Role" value={user.role} onChange={(e) => setUser({ ...user, role: e.target.value })}><option value="agent">Agent</option><option value="admin">Admin</option></select>
              <button className="btn btn-outline" disabled={!user.name || !user.email || user.password.length < 8} onClick={async () => { if (await run(() => api('POST', '/users', user), 'Teammate added')) { setUser({ name: '', email: '', password: '', role: 'agent' }); refresh() } }}>Add teammate</button>
            </div>
          )}
          <p className="mt-2 text-xs text-slate-500">Agents work the inbox, tickets, automations and knowledge. Admins also manage numbers, AI, API keys and settings.</p>
        </section>

        <section className="card p-5">
          <h2 className="font-medium">Labels</h2>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {labels.map((l) => <span key={l.id} className="chip" style={{ background: `${l.color}1a`, color: l.color }}>{l.name}<button className="cursor-pointer" aria-label={`Delete label ${l.name}`} onClick={() => run(() => api('DELETE', `/labels/${l.id}`)).then(refresh)}><Trash2 size={11} /></button></span>)}
            {labels.length === 0 && <span className="text-sm text-slate-400">No labels yet.</span>}
          </div>
          <div className="mt-3 flex gap-2">
            <input className="input" placeholder="New label" aria-label="New label name" value={label.name} onChange={(e) => setLabel({ ...label, name: e.target.value })} />
            <input type="color" className="h-9 w-12 cursor-pointer rounded border border-slate-300" aria-label="Label color" value={label.color} onChange={(e) => setLabel({ ...label, color: e.target.value })} />
            <button className="btn btn-outline" disabled={!label.name.trim()} onClick={async () => { if (await run(() => api('POST', '/labels', label))) { setLabel({ ...label, name: '' }); refresh() } }}>Add label</button>
          </div>
        </section>

        <section className="card p-5">
          <h2 className="font-medium">Quick replies</h2>
          <p className="text-sm text-slate-500">Type / in the message box to insert one.</p>
          <div className="mt-2 divide-y divide-slate-100">
            {quick.data?.map((r) => <div key={r.id} className="flex items-center gap-3 py-2 text-sm"><code className="text-brand-700">/{r.shortcut}</code><span className="min-w-0 flex-1 truncate text-slate-600">{r.text}</span><button className="btn btn-danger !p-1.5" aria-label={`Delete quick reply ${r.shortcut}`} onClick={() => run(() => api('DELETE', `/quick-replies/${r.id}`)).then(quick.reload)}><Trash2 size={14} /></button></div>)}
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-4">
            <input className="input" placeholder="shortcut" aria-label="Quick reply shortcut" value={qr.shortcut} onChange={(e) => setQr({ ...qr, shortcut: e.target.value })} />
            <input className="input sm:col-span-2" placeholder="Message text" aria-label="Quick reply text" value={qr.text} onChange={(e) => setQr({ ...qr, text: e.target.value })} />
            <button className="btn btn-outline" disabled={!qr.shortcut.trim() || !qr.text.trim()} onClick={async () => { if (await run(() => api('POST', '/quick-replies', qr))) { setQr({ shortcut: '', text: '' }); quick.reload() } }}>Add quick reply</button>
          </div>
        </section>
      </div>
    </Page>
  )
}
