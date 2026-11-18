import { useState } from 'react'
import { FlaskConical, Plus, QrCode, Smartphone, Trash2 } from 'lucide-react'
import { api, useLive } from '../api'
import { Empty, Field, Modal, Page, StatusDot, Toggle, useAction } from '../ui'
import { useApp } from '../App'

const STATUS: Record<string, string> = { connected: 'Connected', connecting: 'Connecting…', qr: 'Waiting for you to scan', disconnected: 'Disconnected' }

export default function Numbers() {
  const { numbers, refresh, me } = useApp()
  const run = useAction()
  const [adding, setAdding] = useState(false)
  const [linking, setLinking] = useState<string | null>(null)
  useLive((e) => { if (e === 'number.status') refresh() })
  const isAdmin = me.role === 'admin'
  const active = numbers.find((n) => n.id === linking)

  return (
    <Page title="Numbers" subtitle="Link any regular WhatsApp or WhatsApp Business app number as a companion device. No Meta Business API or template approval needed."
      actions={isAdmin && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16} />Add number</button>}>
      {numbers.length === 0 ? (
        <Empty icon={<Smartphone size={22} />} title="No numbers yet" hint="Connect your first WhatsApp number, or add a sandbox number to explore the product without a phone."
          action={isAdmin && <button className="btn btn-primary" onClick={() => setAdding(true)}>Add number</button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {numbers.map((n) => (
            <div key={n.id} className="card p-4" data-testid="number-card">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">{n.kind === 'sandbox' ? <FlaskConical size={16} className="text-violet-600" /> : <Smartphone size={16} className="text-brand-700" />}<span className="truncate">{n.name}</span></div>
                  <div className="mt-1 flex items-center gap-1.5 text-sm text-slate-500"><StatusDot status={n.status} />{STATUS[n.status] || n.status}{n.kind === 'sandbox' ? ' · Sandbox (simulated)' : n.phone ? ` · +${n.phone}` : ''}</div>
                </div>
                {isAdmin && <button className="btn btn-danger !p-1.5" aria-label={`Remove ${n.name}`} onClick={() => confirm(`Remove "${n.name}" and all of its chats? This cannot be undone.`) && run(() => api('DELETE', `/numbers/${n.id}`), 'Number removed').then(refresh)}><Trash2 size={15} /></button>}
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                <div className="flex items-center gap-2 text-sm"><Toggle label={`AI agent replies on ${n.name}`} checked={n.ai_enabled} onChange={(v) => isAdmin && run(() => api('PATCH', `/numbers/${n.id}`, { ai_enabled: v })).then(refresh)} />AI agent replies</div>
                {n.kind === 'whatsapp' && isAdmin && (n.status === 'connected'
                  ? <button className="btn btn-outline" onClick={() => confirm('Unlink this number from Switchboard?') && run(() => api('POST', `/numbers/${n.id}/logout`)).then(refresh)}>Unlink</button>
                  : <button className="btn btn-primary" onClick={async () => { if (n.status === 'disconnected') await run(() => api('POST', `/numbers/${n.id}/connect`)); await refresh(); setLinking(n.id) }}><QrCode size={15} />Link device</button>)}
              </div>
            </div>
          ))}
        </div>
      )}
      {adding && <AddNumber onClose={() => setAdding(false)} onCreated={async (n) => { setAdding(false); await refresh(); if (n.kind === 'whatsapp') setLinking(n.id) }} />}
      {active && active.status !== 'connected' && <LinkDevice number={active} onClose={() => setLinking(null)} />}
    </Page>
  )
}

function AddNumber({ onClose, onCreated }: { onClose: () => void; onCreated: (n: any) => void }) {
  const run = useAction()
  const [kind, setKind] = useState<'whatsapp' | 'sandbox'>('whatsapp')
  const [name, setName] = useState('')
  return (
    <Modal title="Add a number" onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {([['whatsapp', 'WhatsApp number', 'Link a real phone by QR code.', Smartphone], ['sandbox', 'Sandbox number', 'Simulated chats for testing.', FlaskConical]] as const).map(([k, title, hint, Icon]) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`cursor-pointer rounded-xl border p-3 text-left ${kind === k ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <Icon size={18} className="mb-1 text-brand-700" /><div className="text-sm font-medium">{title}</div><div className="text-xs text-slate-500">{hint}</div>
            </button>
          ))}
        </div>
        <Field label="Name" hint="Shown to your team, for example Sales or Support."><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'sandbox' ? 'Sandbox' : 'Support line'} autoFocus /></Field>
        <button className="btn btn-primary w-full" onClick={async () => { const n = await run(() => api('POST', '/numbers', { name: name.trim() || (kind === 'sandbox' ? 'Sandbox' : 'WhatsApp'), kind })); if (n) onCreated(n) }}>{kind === 'sandbox' ? 'Create sandbox number' : 'Continue to link device'}</button>
      </div>
    </Modal>
  )
}

function LinkDevice({ number, onClose }: { number: any; onClose: () => void }) {
  const run = useAction()
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  return (
    <Modal title={`Link ${number.name}`} onClose={onClose}>
      <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-slate-600">
        <li>Open WhatsApp on the phone.</li>
        <li>Go to Settings, then Linked devices, then Link a device.</li>
        <li>Scan this code.</li>
      </ol>
      <div className="flex min-h-64 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-4">
        {number.qr ? <img src={number.qr} alt="WhatsApp QR code" className="h-64 w-64" /> : <span className="text-sm text-slate-500">{number.status === 'disconnected' ? 'Disconnected. Close this and press Link device again.' : 'Getting a QR code from WhatsApp…'}</span>}
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer text-slate-600">Cannot scan? Link with a code instead</summary>
        <div className="mt-2 flex gap-2">
          <input className="input" placeholder="Phone with country code, e.g. 14155550123" aria-label="Phone number" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn btn-outline" onClick={async () => { const r = await run(() => api('POST', `/numbers/${number.id}/pairing-code`, { phone })); if (r) setCode(r.code) }}>Get code</button>
        </div>
        {code && <p className="mt-2">On the phone choose <b>Link with phone number instead</b> and enter <b className="font-mono text-base tracking-widest">{code}</b></p>}
      </details>
    </Modal>
  )
}
