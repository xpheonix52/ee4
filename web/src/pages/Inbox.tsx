import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Bot, Check, CheckCheck, Clock, FileText, Paperclip, PanelRight, Search, Send, Sparkles, StickyNote, TriangleAlert, X } from 'lucide-react'
import { api, clock, timeAgo, useData, useLive } from '../api'
import { Avatar, Empty, Modal, useAction } from '../ui'
import { useApp } from '../App'

const TABS = [['all', 'All'], ['unread', 'Unread'], ['mine', 'Mine'], ['unassigned', 'Unassigned']] as const

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
            <input className="input !pl-8" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" />
          </div>
          <div className="flex gap-1">
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
                {(c.labels.length > 0 || c.status === 'closed') && (
                  <div className="mt-1 flex flex-wrap gap-1">
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
                <Bubble m={m} group={chat.type === 'group'} />
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
            <button className="btn btn-ghost !px-2 !py-1 !text-xs" onClick={draft} disabled={drafting}><Sparkles size={13} />{drafting ? 'Drafting…' : 'AI draft'}</button>
          </div>
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

function Bubble({ m, group }: { m: any; group: boolean }) {
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
    <div className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
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
