import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { BookOpen, Bot, Sparkles, Code2, Home as HomeIcon, Inbox as InboxIcon, LogOut, Megaphone, Settings as SettingsIcon, Smartphone, Ticket, Workflow } from 'lucide-react'
import { api, connectLive, disconnectLive, useLive } from './api'
import { Field, useAction } from './ui'
import Home from './pages/Home'
import Inbox from './pages/Inbox'
import Numbers from './pages/Numbers'
import Automations from './pages/Automations'
import Knowledge from './pages/Knowledge'
import Agent from './pages/Agent'
import Tickets from './pages/Tickets'
import Broadcasts from './pages/Broadcasts'
import Developers from './pages/Developers'
import Settings from './pages/Settings'
import Assistant from './pages/Assistant'

type AppState = { me: any; workspace: any; users: any[]; numbers: any[]; labels: any[]; refresh: () => Promise<void> }
const Ctx = createContext<AppState>(null as any)
export const useApp = () => useContext(Ctx)

const NAV = [
  { to: '/', label: 'Home', icon: HomeIcon },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
  { to: '/tickets', label: 'Tickets', icon: Ticket },
  { to: '/automations', label: 'Automations', icon: Workflow },
  { to: '/agent', label: 'AI Agent', icon: Bot },
  { to: '/knowledge', label: 'Knowledge', icon: BookOpen },
  { to: '/assistant', label: 'Assistant', icon: Sparkles },
  { to: '/broadcasts', label: 'Broadcasts', icon: Megaphone },
  { to: '/numbers', label: 'Numbers', icon: Smartphone },
  { to: '/developers', label: 'API & MCP', icon: Code2 },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export default function App() {
  const [phase, setPhase] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading')
  const [state, setState] = useState<Omit<AppState, 'refresh'>>({ me: null, workspace: null, users: [], numbers: [], labels: [] })
  const [unread, setUnread] = useState(0)
  const navigate = useNavigate()

  const refresh = useCallback(async () => {
    const [me, users, numbers, labels, chats] = await Promise.all([api('GET', '/me'), api('GET', '/users'), api('GET', '/numbers'), api('GET', '/labels'), api('GET', '/chats?unread=true&limit=500')])
    setState({ me: me.user, workspace: me.workspace, users, numbers, labels })
    setUnread(chats.length)
  }, [])

  const boot = useCallback(async () => {
    try {
      const s = await api('GET', '/setup/status')
      if (s.needs_setup) return setPhase('setup')
      await refresh()
      connectLive()
      setPhase('ready')
    } catch { setPhase('login') }
  }, [refresh])

  useEffect(() => { boot() }, [boot])
  useEffect(() => {
    const out = () => { disconnectLive(); setPhase('login') }
    window.addEventListener('sb-signed-out', out)
    return () => window.removeEventListener('sb-signed-out', out)
  }, [])
  useLive((event) => {
    if (phase !== 'ready') return
    if (['message.received', 'chat.updated', 'chat.created', 'number.status'].includes(event)) refresh().catch(() => {})
  })

  if (phase === 'loading') return <div className="flex h-full items-center justify-center text-slate-400">Loading…</div>
  if (phase === 'setup' || phase === 'login') return <AuthScreen mode={phase} onDone={boot} />

  const logout = async () => { await api('POST', '/auth/logout').catch(() => {}); disconnectLive(); navigate('/'); setPhase('login') }
  return (
    <Ctx.Provider value={{ ...state, refresh }}>
      <div className="flex h-full">
        <nav className="flex w-14 shrink-0 flex-col border-r border-slate-200 bg-white py-3 lg:w-52" aria-label="Main">
          <div className="mb-4 flex items-center gap-2 px-3 lg:px-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-700 font-bold text-white">S</div>
            <div className="hidden min-w-0 lg:block">
              <div className="truncate text-sm leading-tight font-semibold">Switchboard</div>
              <div className="truncate text-xs text-slate-500">{state.workspace?.name}</div>
            </div>
          </div>
          <div className="flex-1 space-y-0.5 px-2">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} end={to === '/'} title={label}
                className={({ isActive }) => `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium ${isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-100'}`}>
                <Icon size={18} className="shrink-0" />
                <span className="hidden flex-1 lg:inline">{label}</span>
                {to === '/inbox' && unread > 0 && <span className="hidden rounded-full bg-brand-700 px-1.5 text-xs text-white lg:inline" data-testid="unread-badge">{unread}</span>}
              </NavLink>
            ))}
          </div>
          <div className="border-t border-slate-200 px-2 pt-2">
            <button onClick={logout} title="Sign out" className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-slate-600 hover:bg-slate-100">
              <LogOut size={18} className="shrink-0" />
              <span className="hidden truncate lg:inline">{state.me?.name} · Sign out</span>
            </button>
          </div>
        </nav>
        <main className="min-w-0 flex-1">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/inbox/:chatId" element={<Inbox />} />
            <Route path="/tickets" element={<Tickets />} />
            <Route path="/automations" element={<Automations />} />
            <Route path="/agent" element={<Agent />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/broadcasts" element={<Broadcasts />} />
            <Route path="/numbers" element={<Numbers />} />
            <Route path="/developers" element={<Developers />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </Ctx.Provider>
  )
}

function AuthScreen({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => void }) {
  const run = useAction()
  const [f, setF] = useState({ workspace: '', name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value })
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const ok = await run(() => mode === 'setup'
      ? api('POST', '/setup', { ...f, timezoneOffsetMinutes: -new Date().getTimezoneOffset() })
      : api('POST', '/auth/login', { email: f.email, password: f.password }))
    setBusy(false)
    if (ok) onDone()
  }
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-700 text-lg font-bold text-white">S</div>
          <div>
            <h1 className="text-lg font-semibold">{mode === 'setup' ? 'Welcome to Switchboard' : 'Sign in'}</h1>
            <p className="text-sm text-slate-500">{mode === 'setup' ? 'Create the admin account to get started.' : 'Your team WhatsApp workspace.'}</p>
          </div>
        </div>
        {mode === 'setup' && <Field label="Team or company name"><input className="input" value={f.workspace} onChange={set('workspace')} placeholder="Acme Inc" required autoFocus /></Field>}
        {mode === 'setup' && <Field label="Your name"><input className="input" value={f.name} onChange={set('name')} required /></Field>}
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} required autoFocus={mode === 'login'} /></Field>
        <Field label="Password" hint={mode === 'setup' ? 'At least 8 characters.' : undefined}><input className="input" type="password" value={f.password} onChange={set('password')} required minLength={mode === 'setup' ? 8 : 1} /></Field>
        <button className="btn btn-primary w-full !py-2" disabled={busy}>{busy ? 'One moment…' : mode === 'setup' ? 'Create workspace' : 'Sign in'}</button>
      </form>
    </div>
  )
}
