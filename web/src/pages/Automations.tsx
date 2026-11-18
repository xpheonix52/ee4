import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2, Workflow, Zap } from 'lucide-react'
import { api, dateTime, useData, useLive } from '../api'
import { CopyText, Empty, Field, Modal, Page, Toggle, useAction } from '../ui'
import { useApp } from '../App'

const TRIGGERS: Record<string, string> = {
  'message.received': 'A message is received', 'message.sent': 'A teammate sends a message', 'message.reaction': 'Someone reacts to a message with an emoji', 'chat.created': 'A new chat starts',
  'ticket.created': 'A ticket is created', 'ticket.updated': 'A ticket is updated', webhook: 'Another app calls a webhook', schedule: 'On a schedule',
}
const FIELDS: Record<string, string> = {
  'message.text': 'Message text', 'chat.type': 'Chat type (dm or group)', 'chat.name': 'Chat name', 'chat.labels': 'Chat labels', 'contact.phone': 'Contact phone',
  'number.name': 'Number name', 'chat.assignee_id': 'Assignee', 'time.business_hours': 'Within business hours', 'reaction.emoji': 'Reaction emoji', 'reaction.from_team': 'Reaction is from our own number', 'chat.internal': 'Chat is internal', 'ticket.status': 'Ticket status', 'ticket.priority': 'Ticket priority',
}
const OPS: Record<string, string> = {
  contains: 'contains any of', not_contains: 'does not contain', equals: 'is exactly', not_equals: 'is not', starts_with: 'starts with', matches: 'matches pattern (regex)',
  is_empty: 'is empty', is_not_empty: 'is not empty', is_true: 'is true', is_false: 'is false',
}
const NO_VALUE = ['is_empty', 'is_not_empty', 'is_true', 'is_false']
type FieldDef = { key: string; label: string; kind?: 'text' | 'area' | 'select' | 'user' | 'chat'; options?: [string, string][]; placeholder?: string }
const ACTIONS: Record<string, { label: string; fields: FieldDef[] }> = {
  send_message: { label: 'Send a WhatsApp message', fields: [{ key: 'text', label: 'Message', kind: 'area', placeholder: 'Hi {{contact.name}}, thanks for your message!' }, { key: 'chat_id', label: 'Send to', kind: 'chat' }] },
  ai_reply: { label: 'Reply with the AI agent', fields: [] },
  ai_generate: { label: 'Ask AI (use the answer in later steps)', fields: [{ key: 'prompt', label: 'Prompt', kind: 'area', placeholder: 'Classify this message as sales, support or spam: {{message.text}}' }] },
  add_label: { label: 'Add a label', fields: [{ key: 'label', label: 'Label', placeholder: 'Lead' }] },
  remove_label: { label: 'Remove a label', fields: [{ key: 'label', label: 'Label' }] },
  assign: { label: 'Assign the chat', fields: [{ key: 'user_id', label: 'Assign to', kind: 'user' }] },
  create_ticket: { label: 'Create a ticket', fields: [{ key: 'title', label: 'Title', placeholder: '{{message.text}}' }, { key: 'priority', label: 'Priority', kind: 'select', options: [['medium', 'Medium'], ['low', 'Low'], ['high', 'High'], ['urgent', 'Urgent']] }] },
  update_ticket: { label: 'Update the ticket', fields: [{ key: 'status', label: 'Status', kind: 'select', options: [['', 'Keep as is'], ['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved']] }, { key: 'priority', label: 'Priority', kind: 'select', options: [['', 'Keep as is'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']] }] },
  set_property: { label: 'Set a chat property', fields: [{ key: 'key', label: 'Property name', placeholder: 'plan' }, { key: 'value', label: 'Value', placeholder: '{{ai.output}}' }] },
  add_note: { label: 'Add a private note', fields: [{ key: 'text', label: 'Note', kind: 'area', placeholder: 'AI says: {{ai.output}}' }] },
  http_request: { label: 'Call another app (HTTP request)', fields: [{ key: 'method', label: 'Method', kind: 'select', options: [['POST', 'POST'], ['GET', 'GET'], ['PUT', 'PUT'], ['PATCH', 'PATCH']] }, { key: 'url', label: 'URL', placeholder: 'https://hooks.example.com/new-lead' }, { key: 'headers', label: 'Headers (JSON, optional)', placeholder: '{"Authorization": "Bearer ..."}' }, { key: 'body', label: 'Body (optional, defaults to the message and chat)', kind: 'area', placeholder: '{"phone": "{{contact.phone}}", "text": "{{message.text}}"}' }] },
  set_ai_mode: { label: 'Turn the AI agent on or off in this chat', fields: [{ key: 'mode', label: 'AI agent', kind: 'select', options: [['off', 'Off'], ['on', 'On'], ['default', 'Follow the number']] }] },
  set_chat_status: { label: 'Close or reopen the chat', fields: [{ key: 'status', label: 'Status', kind: 'select', options: [['closed', 'Closed'], ['open', 'Open']] }] },
  wait: { label: 'Wait', fields: [{ key: 'seconds', label: 'Seconds (max 300)', placeholder: '5' }] },
}
const VARIABLES = ['{{chat.props.name}}', '{{reaction.emoji}}', '{{message.text}}', '{{contact.name}}', '{{contact.phone}}', '{{chat.name}}', '{{number.name}}', '{{ticket.seq}}', '{{ticket.title}}', '{{ai.output}}', '{{http.body}}', '{{http.json.field}}', '{{webhook.field}}']

const TEMPLATES = [
  { icon: '👋', name: 'Welcome new contacts', hint: 'Greets anyone who messages you for the first time.', a: { trigger: { type: 'chat.created' }, conditions: [{ field: 'chat.type', op: 'equals', value: 'dm' }], actions: [{ type: 'send_message', text: 'Hi {{contact.name}}! Thanks for reaching out. How can we help?' }] } },
  { icon: '🌙', name: 'Away message outside business hours', hint: 'Sends one reply per chat every 8 hours when you are closed.', a: { trigger: { type: 'message.received' }, cooldown_minutes: 480, conditions: [{ field: 'time.business_hours', op: 'is_false' }, { field: 'chat.type', op: 'equals', value: 'dm' }], actions: [{ type: 'send_message', text: 'Thanks for your message! We are closed right now and will reply when we are back.' }] } },
  { icon: '🎫', name: 'Create tickets from keywords', hint: 'Turns messages about problems into high-priority tickets.', a: { trigger: { type: 'message.received' }, conditions: [{ field: 'message.text', op: 'contains', value: 'urgent, broken, not working, refund, complaint' }], actions: [{ type: 'create_ticket', title: '{{message.text}}', priority: 'high' }, { type: 'add_label', label: 'Issue' }, { type: 'assign' }] } },
  { icon: '👍', name: 'Emoji ticketing', hint: 'React to any message with 🎫 on your phone to raise a ticket from it.', a: { trigger: { type: 'message.reaction' }, conditions: [{ field: 'reaction.emoji', op: 'equals', value: '🎫' }, { field: 'reaction.from_team', op: 'is_true' }], actions: [{ type: 'create_ticket', title: '{{message.text}}', priority: 'medium' }] } },
  { icon: '🤖', name: 'AI triage and routing', hint: 'AI classifies each message, then labels the chat.', a: { trigger: { type: 'message.received' }, conditions: [{ field: 'chat.type', op: 'equals', value: 'dm' }], actions: [{ type: 'ai_generate', prompt: 'Reply with exactly one word (Sales, Support, Billing or Other) for this message: {{message.text}}' }, { type: 'add_label', label: '{{ai.output}}' }] } },
  { icon: '🔗', name: 'Send new leads to your CRM', hint: 'Posts each new chat to any URL: Zapier, Make, n8n or your own API.', a: { trigger: { type: 'chat.created' }, actions: [{ type: 'http_request', method: 'POST', url: 'https://example.com/your-webhook', body: '{"name": "{{contact.name}}", "phone": "{{contact.phone}}"}' }, { type: 'add_label', label: 'Lead' }] } },
  { icon: '📦', name: 'Notify customers from your system', hint: 'Your app calls a webhook; the customer gets a WhatsApp message.', a: { trigger: { type: 'webhook' }, actions: [{ type: 'send_message', text: 'Your order {{webhook.order}} is on its way!' }] } },
  { icon: '⏰', name: 'Daily reminder to a group', hint: 'Posts a message to a chosen chat every weekday.', a: { trigger: { type: 'schedule', time: '09:00', days: [1, 2, 3, 4, 5] }, actions: [{ type: 'send_message', text: 'Good morning team! Please post your updates.' }] } },
  { icon: '🙋', name: 'Hand off to a human on request', hint: 'Stops the AI agent and assigns a teammate when asked.', a: { trigger: { type: 'message.received' }, conditions: [{ field: 'message.text', op: 'contains', value: 'human, agent, real person, representative' }], actions: [{ type: 'set_ai_mode', mode: 'off' }, { type: 'assign' }, { type: 'add_label', label: 'Needs human' }, { type: 'send_message', text: 'Of course. A teammate will be with you shortly.' }] } },
]

export default function Automations() {
  const list = useData<any[]>('/automations')
  const run = useAction()
  const [editing, setEditing] = useState<any>(null)
  const [picking, setPicking] = useState(false)
  const [runsFor, setRunsFor] = useState<any>(null)
  useLive((e) => { if (e === 'automation.run') list.reload() })
  const blank = { name: '', enabled: true, trigger: { type: 'message.received' }, conditions: [], match: 'all', actions: [{ type: 'send_message', text: '' }], cooldown_minutes: 0 }

  return (
    <Page title="Automations" subtitle="When something happens on WhatsApp, check conditions, then run any number of steps: reply, label, assign, create tickets, call other apps or ask AI."
      actions={<button className="btn btn-primary" onClick={() => setPicking(true)}><Plus size={16} />New automation</button>}>
      {list.data?.length === 0 && <Empty icon={<Workflow size={22} />} title="No automations yet" hint="Start from a ready-made template and adjust it, or build one from scratch." action={<button className="btn btn-primary" onClick={() => setPicking(true)}>Browse templates</button>} />}
      <div className="space-y-2">
        {list.data?.map((a) => (
          <div key={a.id} className="card flex items-center gap-3 p-4" data-testid="automation-row">
            <Toggle label={`Enable ${a.name}`} checked={a.enabled} onChange={(v) => run(() => api('PUT', `/automations/${a.id}`, { enabled: v })).then(list.reload)} />
            <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={() => setEditing(a)}>
              <div className="truncate font-medium">{a.name}</div>
              <div className="truncate text-sm text-slate-500">When {TRIGGERS[a.trigger.type]?.toLowerCase()} · {a.actions.map((x: any) => ACTIONS[x.type]?.label || x.type).join(' → ')}</div>
            </button>
            <button className="btn btn-ghost !text-xs" onClick={() => setRunsFor(a)}>{a.run_count} run{a.run_count === 1 ? '' : 's'}</button>
            <button className="btn btn-danger !p-1.5" aria-label={`Delete ${a.name}`} onClick={() => confirm(`Delete "${a.name}"?`) && run(() => api('DELETE', `/automations/${a.id}`)).then(list.reload)}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      {picking && (
        <Modal title="New automation" onClose={() => setPicking(false)} wide>
          <div className="grid gap-2 sm:grid-cols-2">
            <button className="cursor-pointer rounded-xl border border-dashed border-slate-300 p-3 text-left hover:border-brand-600 hover:bg-brand-50" onClick={() => { setPicking(false); setEditing(blank) }}>
              <div className="font-medium"><Zap size={15} className="mr-1 inline" />Start from scratch</div><div className="text-sm text-slate-500">Pick your own trigger, conditions and steps.</div>
            </button>
            {TEMPLATES.map((t) => (
              <button key={t.name} className="cursor-pointer rounded-xl border border-slate-200 p-3 text-left hover:border-brand-600 hover:bg-brand-50" onClick={() => { setPicking(false); setEditing({ ...blank, ...structuredClone(t.a), name: t.name }) }}>
                <div className="font-medium">{t.icon} {t.name}</div><div className="text-sm text-slate-500">{t.hint}</div>
              </button>
            ))}
          </div>
        </Modal>
      )}
      {editing && <Builder initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); list.reload() }} />}
      {runsFor && <Runs automation={runsFor} onClose={() => setRunsFor(null)} />}
    </Page>
  )
}

function Builder({ initial, onClose, onSaved }: { initial: any; onClose: () => void; onSaved: () => void }) {
  const run = useAction()
  const { users } = useApp()
  const chats = useData<any[]>('/chats?limit=300').data || []
  const [a, setA] = useState<any>(() => structuredClone(initial))
  const set = (patch: any) => setA((cur: any) => ({ ...cur, ...patch }))
  const setAt = (key: 'conditions' | 'actions', i: number, patch: any) => set({ [key]: a[key].map((x: any, j: number) => (j === i ? { ...x, ...patch } : x)) })
  const move = (i: number, d: number) => { const next = [...a.actions]; [next[i], next[i + d]] = [next[i + d], next[i]]; set({ actions: next }) }
  const needsChat = !['message.received', 'message.sent', 'message.reaction', 'chat.created'].includes(a.trigger.type)

  const save = async () => {
    const ok = await run(() => api(a.id ? 'PUT' : 'POST', a.id ? `/automations/${a.id}` : '/automations', { name: a.name, enabled: a.enabled, trigger: a.trigger, conditions: a.conditions, match: a.match, actions: a.actions, cooldown_minutes: Number(a.cooldown_minutes) || 0 }), 'Automation saved')
    if (ok) onSaved()
  }
  const hookUrl = a.id && a.trigger.type === 'webhook' ? `${location.origin}/api/v1/hooks/${a.id}/${a.hook_token}` : ''

  return (
    <Modal title={a.id ? 'Edit automation' : 'New automation'} onClose={onClose} wide>
      <div className="space-y-5">
        <Field label="Name"><input className="input" value={a.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Reply to pricing questions" autoFocus /></Field>

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">When</h3>
          <div className="rounded-xl border border-slate-200 p-3">
            <select className="input" aria-label="Trigger" value={a.trigger.type} onChange={(e) => set({ trigger: e.target.value === 'schedule' ? { type: 'schedule', time: '09:00', days: [1, 2, 3, 4, 5] } : { type: e.target.value } })}>
              {Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            {a.trigger.type === 'schedule' && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <input type="time" className="input !w-32" aria-label="Time" value={a.trigger.time || '09:00'} onChange={(e) => set({ trigger: { ...a.trigger, time: e.target.value } })} />
                <div className="flex gap-1">
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => {
                    const on = (a.trigger.days || []).includes(i)
                    return <button key={i} type="button" aria-pressed={on} aria-label={['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]} onClick={() => set({ trigger: { ...a.trigger, days: on ? a.trigger.days.filter((x: number) => x !== i) : [...(a.trigger.days || []), i] } })} className={`h-8 w-8 cursor-pointer rounded-full text-xs font-medium ${on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-500'}`}>{d}</button>
                  })}
                </div>
              </div>
            )}
            {a.trigger.type === 'webhook' && (hookUrl
              ? <div className="mt-3 space-y-1"><div className="text-xs text-slate-500">POST any JSON to this URL. Its fields become {'{{webhook.field}}'} variables. Include "chat_id" to target a chat.</div><CopyText text={hookUrl} /></div>
              : <div className="mt-3 text-xs text-slate-500">Save the automation to get its webhook URL.</div>)}
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Only if (optional)</h3>
            {a.conditions.length > 1 && (
              <select className="rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label="Match" value={a.match} onChange={(e) => set({ match: e.target.value })}><option value="all">All conditions match</option><option value="any">Any condition matches</option></select>
            )}
          </div>
          <div className="space-y-2">
            {a.conditions.map((c: any, i: number) => (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 p-2">
                <select className="input !w-auto flex-1" aria-label="Condition field" value={c.field} onChange={(e) => setAt('conditions', i, { field: e.target.value, ...(['time.business_hours', 'reaction.from_team', 'chat.internal'].includes(e.target.value) ? { op: 'is_true' } : {}) })}>{Object.entries(FIELDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                <select className="input !w-auto" aria-label="Condition operator" value={c.op} onChange={(e) => setAt('conditions', i, { op: e.target.value })}>{Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                {!NO_VALUE.includes(c.op) && <input className="input !w-auto flex-1" aria-label="Condition value" placeholder={c.op === 'contains' ? 'price, cost, quote' : 'value'} value={c.value || ''} onChange={(e) => setAt('conditions', i, { value: e.target.value })} />}
                <button className="btn btn-danger !p-1.5" aria-label="Remove condition" onClick={() => set({ conditions: a.conditions.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="btn btn-outline" onClick={() => set({ conditions: [...a.conditions, { field: 'message.text', op: 'contains', value: '' }] })}><Plus size={14} />Add condition</button>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Then</h3>
          <div className="space-y-2">
            {a.actions.map((act: any, i: number) => (
              <div key={i} className="rounded-xl border border-slate-200 p-3" data-testid="action-card">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-800">{i + 1}</span>
                  <select className="input flex-1" aria-label={`Step ${i + 1} action`} value={act.type} onChange={(e) => set({ actions: a.actions.map((x: any, j: number) => (j === i ? { type: e.target.value } : x)) })}>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
                  <button className="btn btn-ghost !p-1.5" aria-label="Move step up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></button>
                  <button className="btn btn-ghost !p-1.5" aria-label="Move step down" disabled={i === a.actions.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></button>
                  <button className="btn btn-danger !p-1.5" aria-label="Remove step" disabled={a.actions.length === 1} onClick={() => set({ actions: a.actions.filter((_: any, j: number) => j !== i) })}><Trash2 size={14} /></button>
                </div>
                <div className="mt-2 space-y-2">
                  {ACTIONS[act.type]?.fields.filter((f) => f.kind !== 'chat' || needsChat).map((f) => (
                    <Field key={f.key} label={f.label}>
                      {f.kind === 'area' ? <textarea className="input" rows={3} placeholder={f.placeholder} value={act[f.key] || ''} onChange={(e) => setAt('actions', i, { [f.key]: e.target.value })} />
                        : f.kind === 'select' ? <select className="input" value={act[f.key] || f.options![0][0]} onChange={(e) => setAt('actions', i, { [f.key]: e.target.value })}>{f.options!.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                        : f.kind === 'user' ? <select className="input" value={act[f.key] || ''} onChange={(e) => setAt('actions', i, { [f.key]: e.target.value })}><option value="">Whoever has the fewest open chats</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
                        : f.kind === 'chat' ? <select className="input" value={act[f.key] || ''} onChange={(e) => setAt('actions', i, { [f.key]: e.target.value })}><option value="">{a.trigger.type === 'schedule' ? 'Choose a chat…' : 'The chat from the trigger'}</option>{chats.map((c) => <option key={c.id} value={c.id}>{c.name}{c.type === 'group' ? ' (group)' : ''}</option>)}</select>
                        : <input className="input" placeholder={f.placeholder} value={act[f.key] || ''} onChange={(e) => setAt('actions', i, { [f.key]: e.target.value })} />}
                    </Field>
                  ))}
                </div>
              </div>
            ))}
            <button className="btn btn-outline" onClick={() => set({ actions: [...a.actions, { type: 'send_message', text: '' }] })}><Plus size={14} />Add step</button>
          </div>
          <div className="mt-3 text-xs text-slate-500">Variables you can use in any text: {VARIABLES.map((v) => <code key={v} className="mr-1 rounded bg-slate-100 px-1 py-0.5 whitespace-nowrap">{v}</code>)}</div>
        </section>

        <Field label="Cooldown per chat (minutes)" hint="Run at most once per chat in this window. Use it for away messages so customers are not spammed. 0 means no limit.">
          <input className="input !w-32" type="number" min={0} value={a.cooldown_minutes} onChange={(e) => set({ cooldown_minutes: e.target.value })} />
        </Field>
        <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={!a.name.trim()}>Save automation</button>
        </div>
      </div>
    </Modal>
  )
}

function Runs({ automation, onClose }: { automation: any; onClose: () => void }) {
  const runs = useData<any[]>(`/automations/${automation.id}/runs`).data
  return (
    <Modal title={`Run history · ${automation.name}`} onClose={onClose} wide>
      {runs?.length === 0 && <p className="text-sm text-slate-500">This automation has not run yet.</p>}
      <div className="space-y-2">
        {runs?.map((r) => (
          <div key={r.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex items-center justify-between"><span className={`chip ${r.status === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>{r.status === 'success' ? 'Succeeded' : 'Failed'}</span><span className="text-xs text-slate-500">{dateTime(r.created_at)}</span></div>
            <div className="mt-1 truncate text-slate-500">{r.summary}</div>
            <ol className="mt-2 space-y-0.5">{r.log.map((s: any, i: number) => <li key={i} className={s.ok ? '' : 'text-red-600'}>{i + 1}. {ACTIONS[s.action]?.label || s.action}: {s.detail}</li>)}</ol>
          </div>
        ))}
      </div>
    </Modal>
  )
}
