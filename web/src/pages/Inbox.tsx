import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Bot, Check, Ticket, CalendarClock, Wand2, CheckCheck, Clock, FileText, Paperclip, PanelRight, Search, Send, Sparkles, StickyNote, TriangleAlert, X } from 'lucide-react'
import { api, clock, timeAgo, useData, useLive } from '../api'
import { Avatar, Empty, Modal, useAction } from '../ui'
import { useApp } from '../App'

const TABS = [['all', 'All'], ['waiting', 'Needs reply'], ['followup', 'Follow up'], ['unread', 'Unread'], ['mine', 'Mine'], ['unassigned', 'Unassigned']] as const

export default function Inbox() {
  const { chatId } = useParams()
  const nav = useNavigate()
  const { numbers } = useApp()
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('all')
  const [q, setQ] = useState('')
  const [numberId, setNumberId] = useState('')
  const [chats, setChats] = useState<any[] | null>(null)

  const query = useMemo(() => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    if (numberId) p.set('number_id', numberId)
    if (tab === 'unread') p.set('unread', 'true')
    if (tab === 'waiting') p.set('needs_reply', 'true')
    if (tab === 'followup') p.set('follow_up', 'true')
    if (tab === 'mine') p.set('assignee', 'me')
    if (tab === 'unassigned') p.set('assignee', 'none')
    return p.toString()
  }, [q, numberId, tab])
  const load = useCallback(() => api('GET', `/chats?${query}`).then(setChats).catch(() => setChats([])), [query])
  useEffect(() => { const t = setTimeout(load, q ? 200 : 0); return () => clearTimeout(t) }, [load, q])
  useLive((e) => { if (/^(message|chat|note)\./.test(e)) load() })

  return (
    <div className="flex h-full">
      <aside className={`${chatId ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r border-slate-200 bg-white md:w-80`}>
        <div className="space-y-2 border-b border-slate-200 p-3">
          <div className="relative">
            <Search size={15} className="absolute top-2.5 left-2.5 text-slate-400" />
            <input className="input !pl-8" placeholder="Search chats and messages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
          </div>
          <div className="flex flex-wrap gap-1">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium ${tab === k ? 'bg-brand-50 text-brand-800' : 'text-slate-500 hover:bg-slate-100'}`}>{label}</button>
            ))}
          </div>
          {numbers.length > 1 && (
            <select className="input !py-1 text-xs" value={numberId} onChange={(e) => setNumberId(e.target.value)} aria-label="Filter by number">
              <option value="">All numbers</option>
              {numbers.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          )}
        </div>
        <div className="flex-1 overflow-y-auto" data-testid="chat-list">
          {chats?.length === 0 && (
            <div className="p-6 text-center text-sm text-slate-500">
              {numbers.length === 0 ? <>No numbers connected yet. <button className="cursor-pointer font-medium text-brand-700" onClick={() => nav('/numbers')}>Connect one</button> to start receiving chats.</> : q || tab !== 'all' ? 'No chats match this filter.' : 'No chats yet. New messages will appear here.'}
            </div>
          )}
          {chats?.map((c) => (
            <button key={c.id} onClick={() => nav(`/inbox/${c.id}`)} className={`flex w-full cursor-pointer items-start gap-3 border-b border-slate-100 px-3 py-2.5 text-left hover:bg-slate-50 ${c.id === chatId ? 'bg-brand-50/60' : ''}`}>
              <Avatar name={c.name} group={c.type === 'group'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-sm ${c.unread ? 'font-semibold' : 'font-medium'}`}>{c.name}</span>
                  <span className="shrink-0 text-xs text-slate-400">{timeAgo(c.last_message_at)}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className={`truncate text-xs ${c.unread ? 'text-slate-800' : 'text-slate-500'}`}>{c.last_message_preview || 'No messages yet'}</span>
                  {c.unread > 0 && <span className="shrink-0 rounded-full bg-brand-600 px-1.5 text-xs font-medium text-white">{c.unread}</span>}
                </div>
                {(c.labels.length > 0 || c.status === 'closed' || c.follow_up_at) && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.follow_up_at && <span className={`chip ${c.follow_up_at <= Date.now() ? 'bg-red-100 text-red-700' : 'bg-sky-100 text-sky-700'}`}>Follow up {c.follow_up_at <= Date.now() ? 'now' : new Date(c.follow_up_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
                    {c.status === 'closed' && <span className="chip bg-slate-100 text-slate-500">Closed</span>}
                    {c.labels.map((l: any) => <span key={l.id} className="chip" style={{ background: `${l.color}1a`, color: l.color }}>{l.name}</span>)}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      </aside>
      {chatId ? <Conversation key={chatId} chatId={chatId} /> : (
        <div className="hidden flex-1 items-center justify-center p-8 md:flex">
          <Empty title="Pick a chat" hint="Every connected number lands in this one shared inbox. Choose a conversation on the left to reply." />
        </div>
      )}
    </div>
  )
}

function Conversation({ chatId }: { chatId: string }) {
  const nav = useNavigate()
  const run = useAction()
  const { numbers, users, me } = useApp()
  const [chat, setChat] = useState<any>(null)
  const [msgs, setMsgs] = useState<any[]>([])
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [drafting, setDrafting] = useState(false)
  const [details, setDetails] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)
  const [later, setLater] = useState<string | null>(null)
  const rewrite = async (style: string) => { if (!style || !text.trim()) return; setDrafting(true); const r = await run(() => api('POST', `/chats/${chatId}/ai/rewrite`, { text, style })); setDrafting(false); if (r?.text) setText(r.text) }
  const sendLater = async () => { if (await run(() => api('POST', '/scheduled', { chat_ids: [chatId], text: text.trim(), send_at: new Date(later!).toISOString() }), 'Scheduled. See Broadcasts to change or cancel it.')) { setText(''); setLater(null) } }
  const quick = useData<any[]>('/quick-replies').data || []
  const scroller = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const number = numbers.find((n) => n.id === chat?.number_id)

  const loadChat = useCallback(() => api('GET', `/chats/${chatId}`).then(setChat).catch(() => nav('/inbox')), [chatId, nav])
  const loadMsgs = useCallback(() => api('GET', `/chats/${chatId}/messages`).then(setMsgs).catch(() => {}), [chatId])
  useEffect(() => { loadChat(); loadMsgs(); api('POST', `/chats/${chatId}/read`).catch(() => {}) }, [loadChat, loadMsgs, chatId])
  useLive((e, d) => {
    if (d.chat?.id === chatId || d.message?.chat_id === chatId) {
      loadMsgs()
      if (d.chat) setChat(d.chat)
      if (e === 'message.received') api('POST', `/chats/${chatId}/read`).catch(() => {})
    }
  })
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }) }, [msgs.length])

  const send = async () => {
    const body = text.trim()
    if (!body) return
    setText('')
    const ok = await run(() => api('POST', mode === 'note' ? `/chats/${chatId}/notes` : `/chats/${chatId}/messages`, { text: body }))
    if (!ok) setText(body)
    loadMsgs()
  }
  const sendFile = async (file?: File) => {
    if (!file) return
    const fd = new FormData()
    fd.append('file', file)
    if (text.trim()) fd.append('text', text.trim())
    if (await run(() => api('POST', `/chats/${chatId}/messages`, fd))) setText('')
    loadMsgs()
  }
  const draft = async () => {
    setDrafting(true)
    const r = await run(() => api('POST', `/chats/${chatId}/ai/draft`, {}))
    setDrafting(false)
    if (r?.text) { setMode('reply'); setText(r.text) }
  }
  const patch = (p: any) => run(() => api('PATCH', `/chats/${chatId}`, p)).then((c) => c && setChat(c))

  const slash = mode === 'reply' && text.startsWith('/') ? quick.filter((r) => r.shortcut.startsWith(text.slice(1).toLowerCase())) : []
  if (!chat) return <div className="flex-1" />
  const aiOn = chat.ai_mode === 'on' || (chat.ai_mode === 'default' && number?.ai_enabled)

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-[#f4f1ea]">
        <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-3 py-2">
          <button className="btn btn-ghost !p-1 md:hidden" onClick={() => nav('/inbox')} aria-label="Back to chats"><ArrowLeft size={18} /></button>
          <Avatar name={chat.name} group={chat.type === 'group'} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium" data-testid="chat-title">{chat.name}</div>
            <div className="truncate text-xs text-slate-500">{chat.type === 'group' ? 'Group' : chat.phone ? `+${chat.phone}` : 'Direct chat'} · via {number?.name || 'removed number'}{aiOn && <span className="ml-1 text-brand-700">· AI agent on</span>}</div>
          </div>
          <button className="btn btn-outline" onClick={() => patch({ status: chat.status === 'open' ? 'closed' : 'open' })}>{chat.status === 'open' ? 'Close chat' : 'Reopen'}</button>
          <button className="btn btn-ghost !p-1.5 xl:hidden" onClick={() => setDetails(true)} aria-label="Chat details"><PanelRight size={18} /></button>
        </header>

        <div ref={scroller} className="flex-1 space-y-1.5 overflow-y-auto px-3 py-4 sm:px-6" data-testid="messages">
          {msgs.map((m, i) => {
            const day = new Date(m.created_at).toDateString()
            const showDay = i === 0 || new Date(msgs[i - 1].created_at).toDateString() !== day
            return (
              <div key={m.id}>
                {showDay && <div className="my-3 text-center"><span className="rounded-md bg-white/80 px-2 py-0.5 text-xs text-slate-500">{day === new Date().toDateString() ? 'Today' : day}</span></div>}
                <Bubble m={m} group={chat.type === 'group'} onTicket={m.direction === 'in' && m.text ? () => run(() => api('POST', '/tickets', { chat_id: chatId, message_id: m.id, title: m.text.slice(0, 120) }), 'Ticket created from message') : undefined} />
              </div>
            )
          })}
          {msgs.length === 0 && <div className="pt-10 text-center text-sm text-slate-500">No messages yet.</div>}
        </div>

        {number?.kind === 'sandbox' && <Simulator chat={chat} />}

        <footer className={`border-t border-slate-200 p-3 ${mode === 'note' ? 'bg-amber-50' : 'bg-white'}`}>
          <div className="mb-2 flex items-center gap-1">
            <button onClick={() => setMode('reply')} className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium ${mode === 'reply' ? 'bg-brand-50 text-brand-800' : 'text-slate-500 hover:bg-slate-100'}`}>Reply</button>
            <button onClick={() => setMode('note')} className={`flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap ${mode === 'note' ? 'bg-amber-200 text-amber-900' : 'text-slate-500 hover:bg-slate-100'}`}><StickyNote size={12} />Private note</button>
            <div className="flex-1" />
            <button aria-label="Summarize" className="btn btn-ghost !px-2 !py-1 !text-xs" onClick={async () => { const r = await run(() => api('POST', `/chats/${chatId}/ai/summary`, {})); if (r) setSummary(r.text) }}><FileText size={13} /><span className="hidden sm:inline">Summarize</span></button>
            {mode === 'reply' && text.trim() && (
              <select className="cursor-pointer rounded-md border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-700" aria-label="Rewrite with AI" value="" disabled={drafting} onChange={(e) => rewrite(e.target.value)}>
                <option value="">Rewrite…</option><option value="polish">Fix grammar</option><option value="shorter">Make shorter</option><option value="friendlier">Make friendlier</option><option value="translate">Translate to their language</option>
              </select>
            )}
            {mode === 'reply' && text.trim() && <button className="btn btn-ghost !px-2 !py-1 !text-xs" onClick={() => setLater(later === null ? '' : null)}><CalendarClock size={13} /><span className="hidden sm:inline">Send later</span></button>}
            <button className="btn btn-ghost !px-2 !py-1 !text-xs" onClick={draft} disabled={drafting}><Sparkles size={13} />{drafting ? 'Drafting…' : 'AI draft'}</button>
          </div>
          {later !== null && mode === 'reply' && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2 text-sm">
              Send this message at <input type="datetime-local" className="input !w-auto !py-1" aria-label="Send at" value={later} onChange={(e) => setLater(e.target.value)} />
              <button className="btn btn-primary !py-1" disabled={!later || !text.trim()} onClick={sendLater}>Schedule</button>
              <button className="btn btn-ghost !py-1" onClick={() => setLater(null)}>Cancel</button>
            </div>
          )}
          <div className="relative flex items-end gap-2">
            {slash.length > 0 && (
              <div className="card absolute bottom-full left-0 mb-2 w-full max-w-md overflow-hidden shadow-lg">
                {slash.slice(0, 6).map((r) => (
                  <button key={r.id} className="block w-full cursor-pointer px-3 py-2 text-left hover:bg-slate-50" onClick={() => setText(r.text)}>
                    <span className="font-mono text-xs text-brand-700">/{r.shortcut}</span> <span className="text-sm text-slate-600">{r.text.slice(0, 80)}</span>
                  </button>
                ))}
              </div>
            )}
            <input ref={fileInput} type="file" className="hidden" onChange={(e) => { sendFile(e.target.files?.[0]); e.target.value = '' }} />
            {mode === 'reply' && <button className="btn btn-ghost !p-2" onClick={() => fileInput.current?.click()} aria-label="Attach a file"><Paperclip size={18} /></button>}
            <textarea
              className="input max-h-40 min-h-[38px] flex-1 resize-none" rows={Math.min(6, Math.max(1, text.split('\n').length))}
              placeholder={mode === 'note' ? 'Write a note only your team can see…' : 'Type a message. Enter to send, / for quick replies'} aria-label={mode === 'note' ? 'Private note' : 'Message'}
              value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (slash.length) setText(slash[0].text); else send() } }}
            />
            <button className="btn btn-primary !p-2" onClick={send} disabled={!text.trim()} aria-label={mode === 'note' ? 'Add note' : 'Send message'}><Send size={18} /></button>
          </div>
        </footer>
      </section>

      <div className={`${details ? 'fixed inset-0 z-40 flex justify-end bg-slate-900/40' : 'hidden'} xl:static xl:z-auto xl:flex xl:bg-transparent`} onClick={(e) => e.target === e.currentTarget && setDetails(false)}>
        <Details chat={chat} users={users} me={me} patch={patch} setChat={setChat} aiDefault={!!number?.ai_enabled} onClose={() => setDetails(false)} />
      </div>
      {summary !== null && <Modal title="Conversation summary" onClose={() => setSummary(null)}><p className="text-sm whitespace-pre-wrap">{summary}</p></Modal>}
    </>
  )
}

function Bubble({ m, group, onTicket }: { m: any; group: boolean; onTicket?: () => void }) {
  if (m.direction === 'note') {
    return (
      <div className="flex justify-center">
        <div className="max-w-[85%] rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-sm text-amber-900">
          <div className="flex items-center gap-1 text-xs font-medium"><StickyNote size={11} />{m.sender_name || 'Note'} · {clock(m.created_at)}</div>
          <div className="whitespace-pre-wrap">{m.text}</div>
        </div>
      </div>
    )
  }
  const out = m.direction === 'out'
  const by = !out ? null : m.sent_by === 'ai' ? 'AI agent' : m.sent_by?.startsWith('automation') ? `Automation · ${m.sender_name || ''}` : m.sent_by === 'phone' ? 'Sent from phone' : m.sent_by === 'api' ? 'API' : m.sent_by === 'mcp' ? 'MCP' : /^(broadcast|scheduled)/.test(m.sent_by || '') ? 'Scheduled' : m.sender_name
  return (
    <div className={`group flex items-center gap-1 ${out ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-xl px-3 py-1.5 text-sm shadow-sm sm:max-w-[65%] ${out ? 'rounded-br-sm bg-[#d9fdd3]' : 'rounded-bl-sm bg-white'}`}>
        {!out && group && <div className="text-xs font-medium text-brand-700">{m.sender_name}</div>}
        {by && <div className="flex items-center gap-1 text-xs font-medium text-slate-500">{m.sent_by === 'ai' && <Bot size={11} />}{by}</div>}
        {m.media_url && (m.type === 'image' || m.type === 'sticker'
          ? <a href={m.media_url} target="_blank" rel="noreferrer"><img src={m.media_url} alt="Attachment" className="my-1 max-h-64 rounded-lg" /></a>
          : m.type === 'video' ? <video src={m.media_url} controls className="my-1 max-h-64 rounded-lg" />
          : m.type === 'audio' ? <audio src={m.media_url} controls className="my-1" />
          : <a href={m.media_url} target="_blank" rel="noreferrer" className="my-1 flex items-center gap-2 rounded-lg bg-black/5 px-2 py-1.5 text-sm underline"><FileText size={16} />{m.media_name || 'Document'}</a>)}
        {m.text && <div className="break-words whitespace-pre-wrap">{m.text}</div>}
        {!m.text && !m.media_url && <div className="text-slate-500 italic">[{m.type}]</div>}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-slate-500">
          {clock(m.created_at)}
          {out && (m.status === 'failed' ? <span className="flex items-center gap-0.5 text-red-600" title={m.error}><TriangleAlert size={12} />Failed{m.error ? `: ${m.error}` : ''}</span>
            : m.status === 'pending' ? <Clock size={12} aria-label="Sending" /> : m.status === 'sent' ? <Check size={13} aria-label="Sent" />
            : <CheckCheck size={13} aria-label={m.status === 'read' ? 'Read' : 'Delivered'} className={m.status === 'read' ? 'text-sky-500' : ''} />)}
        </div>
      </div>
      {onTicket && <button onClick={onTicket} title="Create a ticket from this message" aria-label="Create a ticket from this message" className="cursor-pointer rounded-full bg-white p-1.5 text-slate-500 opacity-0 shadow-sm group-hover:opacity-100 hover:text-brand-700 focus:opacity-100"><Ticket size={14} /></button>}
    </div>
  )
}

/** Sandbox numbers have no real phone behind them, so let people play the customer. */
function Simulator({ chat }: { chat: any }) {
  const run = useAction()
  const [text, setText] = useState('')
  const go = async () => {
    if (!text.trim()) return
    const body = chat.type === 'group' ? { from: '15550199', name: 'Test member', group: chat.name, text } : { from: chat.phone || chat.jid.split('@')[0], name: chat.name, text }
    if (await run(() => api('POST', `/numbers/${chat.number_id}/simulate`, body))) setText('')
  }
  return (
    <div className="flex items-center gap-2 border-t border-dashed border-slate-300 bg-white/70 px-3 py-2">
      <span className="chip bg-violet-100 text-violet-700">Sandbox</span>
      <input className="input !py-1" placeholder={`Pretend to be ${chat.name}: type what the customer says`} aria-label="Simulate customer message" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      <button className="btn btn-outline !py-1" onClick={go}>Receive</button>
    </div>
  )
}

function Details({ chat, users, me, patch, setChat, aiDefault, onClose }: any) {
  const run = useAction()
  const { labels, refresh } = useApp()
  const tickets = useData<any[]>(`/tickets?chat_id=${chat.id}`)
  useLive((e, d) => { if (e.startsWith('ticket.') && d.ticket?.chat_id === chat.id) tickets.reload() })
  const [newLabel, setNewLabel] = useState('')
  const [ticketTitle, setTicketTitle] = useState('')
  const [prop, setProp] = useState({ key: '', value: '' })
  const setProps = (props: any) => patch({ props })
  const addLabel = async (name: string) => {
    if (!name.trim()) return
    const c = await run(() => api('POST', `/chats/${chat.id}/labels`, { label: name.trim() }))
    if (c) { setChat(c); setNewLabel(''); refresh() }
  }
  const unused = labels.filter((l: any) => !chat.labels.some((x: any) => x.id === l.id))
  return (
    <aside className="h-full w-72 shrink-0 space-y-5 overflow-y-auto border-l border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between xl:hidden"><span className="font-medium">Details</span><button className="btn btn-ghost !p-1" onClick={onClose} aria-label="Close details"><X size={16} /></button></div>
      <div>
        <div className="label">Assigned to</div>
        <select className="input" aria-label="Assigned to" value={chat.assignee_id || ''} onChange={(e) => patch({ assignee_id: e.target.value || null })}>
          <option value="">Nobody</option>
          {users.map((u: any) => <option key={u.id} value={u.id}>{u.name}{u.id === me.id ? ' (you)' : ''}</option>)}
        </select>
      </div>
      <FollowUp chat={chat} patch={patch} />
      <div>
        <div className="label">AI agent in this chat</div>
        <select className="input" aria-label="AI agent in this chat" value={chat.ai_mode} onChange={(e) => patch({ ai_mode: e.target.value })}>
          <option value="default">Follow the number ({aiDefault ? 'on' : 'off'})</option>
          <option value="on">Always on</option>
          <option value="off">Off (humans only)</option>
        </select>
      </div>
      <div>
        <div className="label">Labels</div>
        <div className="mb-2 flex flex-wrap gap-1">
          {chat.labels.map((l: any) => (
            <span key={l.id} className="chip" style={{ background: `${l.color}1a`, color: l.color }}>{l.name}
              <button className="cursor-pointer" aria-label={`Remove label ${l.name}`} onClick={async () => { const c = await run(() => api('DELETE', `/chats/${chat.id}/labels/${l.id}`)); if (c) setChat(c) }}><X size={11} /></button>
            </span>
          ))}
          {chat.labels.length === 0 && <span className="text-xs text-slate-400">None yet</span>}
        </div>
        <div className="flex gap-1">
          <input className="input !py-1" placeholder="Add a label" aria-label="Add a label" list="label-options" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLabel(newLabel)} />
          <datalist id="label-options">{unused.map((l: any) => <option key={l.id} value={l.name} />)}</datalist>
          <button className="btn btn-outline !py-1" onClick={() => addLabel(newLabel)}>Add</button>
        </div>
      </div>
      <div>
        <div className="label">Properties</div>
        <div className="space-y-1">
          {Object.entries(chat.props || {}).map(([k, v]) => (
            <div key={k} className="flex items-center gap-1 text-sm"><span className="w-24 shrink-0 truncate text-slate-500" title={k}>{k}</span>
              <input className="input !py-0.5" aria-label={`Value of ${k}`} defaultValue={v as string} onBlur={(e) => e.target.value !== v && setProps({ ...chat.props, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-1">
          <input className="input !py-1" placeholder="Name" aria-label="Property name" value={prop.key} onChange={(e) => setProp({ ...prop, key: e.target.value })} />
          <input className="input !py-1" placeholder="Value" aria-label="Property value" value={prop.value} onChange={(e) => setProp({ ...prop, value: e.target.value })} />
          <button className="btn btn-outline !py-1" disabled={!prop.key.trim() || !prop.value.trim()} onClick={() => { setProps({ ...chat.props, [prop.key.trim()]: prop.value }); setProp({ key: '', value: '' }) }}>Set</button>
        </div>
        <p className="mt-1 text-xs text-slate-400">The AI agent sees these, and automations can use them as {'{{chat.props.name}}'}.</p>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!chat.internal} onChange={(e) => patch({ internal: e.target.checked })} />Internal contact (the AI agent never replies)</label>
      <a className="block text-xs text-brand-700 underline" href={`/api/v1/export/messages.csv?chat_id=${chat.id}`}>Export this conversation (CSV)</a>
      <div>
        <div className="label">Tickets</div>
        <div className="space-y-1.5">
          {tickets.data?.map((t) => (
            <div key={t.id} className="rounded-lg border border-slate-200 p-2 text-sm">
              <div className="font-medium">#{t.seq} {t.title}</div>
              <select className="mt-1 w-full rounded border border-slate-200 px-1 py-0.5 text-xs" aria-label={`Status of ticket ${t.seq}`} value={t.status} onChange={(e) => run(() => api('PATCH', `/tickets/${t.id}`, { status: e.target.value })).then(tickets.reload)}>
                <option value="open">Open</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option>
              </select>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-1">
          <input className="input !py-1" placeholder="New ticket title" aria-label="New ticket title" value={ticketTitle} onChange={(e) => setTicketTitle(e.target.value)} />
          <button className="btn btn-outline !py-1" disabled={!ticketTitle.trim()} onClick={async () => { if (await run(() => api('POST', '/tickets', { chat_id: chat.id, title: ticketTitle }), 'Ticket created')) { setTicketTitle(''); tickets.reload() } }}>Create</button>
        </div>
      </div>
    </aside>
  )
}

/** "When do we get back to this customer?" Sets a reminder that brings the chat back with a note. */
function FollowUp({ chat, patch }: { chat: any; patch: (p: any) => void }) {
  const [note, setNote] = useState('')
  const [custom, setCustom] = useState('')
  const at = (ms: number) => patch({ follow_up_at: new Date(ms).toISOString(), follow_up_note: note.trim() || null })
  const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() }
  if (chat.follow_up_at) {
    const due = chat.follow_up_at <= Date.now()
    return (
      <div className={`rounded-lg border p-3 text-sm ${due ? 'border-red-200 bg-red-50' : 'border-sky-200 bg-sky-50'}`} data-testid="follow-up">
        <div className="font-medium">{due ? 'Follow-up is due' : 'Follow up'} · {new Date(chat.follow_up_at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
        {chat.follow_up_note && <div className="text-slate-600">{chat.follow_up_note}</div>}
        <button className="btn btn-outline mt-2 !py-1" onClick={() => patch({ follow_up_at: null })}>{due ? 'Mark done' : 'Cancel reminder'}</button>
      </div>
    )
  }
  return (
    <div>
      <div className="label">Remind us to follow up</div>
      <input className="input mb-1.5 !py-1" placeholder="What for? (optional)" aria-label="Follow-up note" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="flex flex-wrap gap-1">
        <button className="btn btn-outline !px-2 !py-1 !text-xs" onClick={() => at(Date.now() + 3_600_000)}>In 1 hour</button>
        <button className="btn btn-outline !px-2 !py-1 !text-xs" onClick={() => at(tomorrow9())}>Tomorrow 9am</button>
        <button className="btn btn-outline !px-2 !py-1 !text-xs" onClick={() => at(Date.now() + 3 * 86_400_000)}>In 3 days</button>
        <button className="btn btn-outline !px-2 !py-1 !text-xs" onClick={() => at(Date.now() + 7 * 86_400_000)}>Next week</button>
      </div>
      <div className="mt-1.5 flex gap-1"><input type="datetime-local" className="input !py-1" aria-label="Custom follow-up time" value={custom} onChange={(e) => setCustom(e.target.value)} /><button className="btn btn-outline !py-1" disabled={!custom} onClick={() => at(new Date(custom).getTime())}>Set</button></div>
    </div>
  )
}
