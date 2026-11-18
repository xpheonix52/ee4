import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { X, Copy, Check } from 'lucide-react'

// ---------- toasts ----------
type Toast = { id: number; text: string; kind: 'ok' | 'error' }
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => {})
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-lg px-4 py-2 text-sm text-white shadow-lg ${t.kind === 'error' ? 'bg-red-600' : 'bg-slate-900'}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
/** Wrap an async action so failures surface as a toast instead of vanishing. */
export function useAction() {
  const toast = useToast()
  return useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    try { const r = await fn(); if (success) toast(success); return r } catch (e: any) { toast(e.message || 'Something went wrong', 'error'); return undefined }
  }, [toast])
}

// ---------- building blocks ----------
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:p-10" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={title} className={`w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-2xl bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn btn-ghost !p-1" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>}
          </div>
          <div className="flex gap-2">{actions}</div>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-full bg-brand-50 p-3 text-brand-700">{icon}</div>}
      <div className="font-medium">{title}</div>
      {hint && <p className="mt-1 max-w-sm text-sm text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}

export function CopyText({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre text-slate-800">{text}</code>
      <button className="btn btn-ghost !p-1" aria-label={label || 'Copy'} onClick={() => { navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
        {done ? <Check size={15} className="text-brand-700" /> : <Copy size={15} />}
      </button>
    </div>
  )
}

export function Avatar({ name, group }: { name?: string; group?: boolean }) {
  const initials = (name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  const hues = ['bg-sky-100 text-sky-700', 'bg-amber-100 text-amber-700', 'bg-violet-100 text-violet-700', 'bg-rose-100 text-rose-700', 'bg-emerald-100 text-emerald-700']
  const hue = hues[(name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length]
  return <div className={`flex h-9 w-9 shrink-0 items-center justify-center text-xs font-semibold ${hue} ${group ? 'rounded-lg' : 'rounded-full'}`}>{initials}</div>
}

export const StatusDot = ({ status }: { status: string }) => (
  <span className={`inline-block h-2 w-2 rounded-full ${status === 'connected' ? 'bg-emerald-500' : status === 'disconnected' ? 'bg-slate-400' : 'bg-amber-500'}`} />
)
