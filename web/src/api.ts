import { useCallback, useEffect, useRef, useState } from 'react'

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(`/api/v1${path}`, {
    method, credentials: 'same-origin',
    headers: body !== undefined && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON error page */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth') && !path.startsWith('/setup') && path !== '/me') window.dispatchEvent(new Event('sb-signed-out'))
    throw new Error(data?.error || `Request failed (${res.status})`)
  }
  return data as T
}

// One shared live connection; pages subscribe to the events they care about.
type Listener = (event: string, data: any) => void
const listeners = new Set<Listener>()
const EVENTS = ['message.received', 'message.sent', 'message.created', 'message.updated', 'note.created', 'chat.created', 'chat.updated', 'ticket.created', 'ticket.updated', 'number.status', 'automation.run']
let source: EventSource | null = null
export function connectLive() {
  if (source) return
  source = new EventSource('/api/v1/events')
  for (const e of EVENTS) source.addEventListener(e, (m) => { const d = JSON.parse((m as MessageEvent).data); listeners.forEach((l) => l(e, d)) })
}
export function disconnectLive() { source?.close(); source = null }
export function useLive(fn: Listener) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const l: Listener = (e, d) => ref.current(e, d)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
}

export function useData<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    if (!path) return
    try { setData(await api<T>('GET', path)); setError('') } catch (e: any) { setError(e.message) }
  }, [path])
  useEffect(() => { setData(null); reload() }, [reload])
  return { data, error, reload, setData }
}

export const timeAgo = (ts?: number | null) => {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 604800) return `${Math.floor(s / 86400)}d`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
export const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
export const dateTime = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
