import { useRef, useState } from 'react'
import { BookOpen, FileUp, Globe, Plus, Search, Trash2 } from 'lucide-react'
import { api, timeAgo, useData } from '../api'
import { Empty, Field, Modal, Page, useAction } from '../ui'

export default function Knowledge() {
  const docs = useData<any[]>('/knowledge')
  const run = useAction()
  const [editing, setEditing] = useState<any>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<any[] | null>(null)
  const search = async () => { if (q.trim()) setHits((await run(() => api('GET', `/knowledge/search?q=${encodeURIComponent(q)}`))) || []) }

  return (
    <Page title="Knowledge hub" subtitle="Everything your AI agent is allowed to know: FAQs, policies, price lists, SOPs. It searches here before answering and hands off to a human when the answer is missing."
      actions={<button className="btn btn-primary" onClick={() => setEditing({ mode: 'text', title: '', content: '', url: '' })}><Plus size={16} />Add knowledge</button>}>
      {docs.data?.length === 0 ? (
        <Empty icon={<BookOpen size={22} />} title="Your knowledge hub is empty" hint="Paste text, import a web page or upload a file. Short, focused documents work best." action={<button className="btn btn-primary" onClick={() => setEditing({ mode: 'text', title: '', content: '', url: '' })}>Add your first document</button>} />
      ) : (
        <>
          <div className="card mb-4 p-4">
            <div className="label">Test what the agent would find</div>
            <div className="flex gap-2">
              <div className="relative flex-1"><Search size={15} className="absolute top-2.5 left-2.5 text-slate-400" /><input className="input !pl-8" placeholder="Ask a customer question, e.g. what is your refund policy?" aria-label="Test search" value={q} onChange={(e) => { setQ(e.target.value); setHits(null) }} onKeyDown={(e) => e.key === 'Enter' && search()} /></div>
              <button className="btn btn-outline" onClick={search}>Search</button>
            </div>
            {hits && (hits.length === 0 ? <p className="mt-3 text-sm text-slate-500">Nothing found. The agent would hand this question to a human.</p> : (
              <div className="mt-3 space-y-2">{hits.map((h, i) => <div key={i} className="rounded-lg bg-slate-50 p-3 text-sm"><div className="font-medium">{h.title}</div><div className="mt-1 line-clamp-3 whitespace-pre-wrap text-slate-600">{h.body}</div></div>)}</div>
            ))}
          </div>
          <div className="card divide-y divide-slate-100">
            {docs.data?.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-4 py-3">
                {d.source === 'url' ? <Globe size={16} className="shrink-0 text-slate-400" /> : d.source === 'file' ? <FileUp size={16} className="shrink-0 text-slate-400" /> : <BookOpen size={16} className="shrink-0 text-slate-400" />}
                <button className="min-w-0 flex-1 cursor-pointer text-left" onClick={async () => { const full = await run(() => api('GET', `/knowledge/${d.id}`)); if (full) setEditing({ ...full, mode: 'text' }) }}>
                  <div className="truncate font-medium">{d.title}</div>
                  <div className="truncate text-xs text-slate-500">{d.size.toLocaleString()} characters · updated {timeAgo(d.updated_at)} ago{d.url ? ` · ${d.url}` : ''}</div>
                </button>
                <button className="btn btn-danger !p-1.5" aria-label={`Delete ${d.title}`} onClick={() => confirm(`Delete "${d.title}"?`) && run(() => api('DELETE', `/knowledge/${d.id}`)).then(docs.reload)}><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </>
      )}
      {editing && <Editor doc={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); docs.reload() }} />}
    </Page>
  )
}

function Editor({ doc, onClose, onSaved }: { doc: any; onClose: () => void; onSaved: () => void }) {
  const run = useAction()
  const [d, setD] = useState(doc)
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const save = async () => {
    setBusy(true)
    const ok = await run(async () => {
      if (d.id) return api('PUT', `/knowledge/${d.id}`, { title: d.title, content: d.content })
      if (d.mode === 'url') return api('POST', '/knowledge', { url: d.url })
      if (d.mode === 'file') { const fd = new FormData(); fd.append('file', file.current!.files![0]); return api('POST', '/knowledge/upload', fd) }
      return api('POST', '/knowledge', { title: d.title, content: d.content })
    }, 'Saved to the knowledge hub')
    setBusy(false)
    if (ok) onSaved()
  }
  return (
    <Modal title={d.id ? 'Edit document' : 'Add knowledge'} onClose={onClose} wide>
      <div className="space-y-4">
        {!d.id && (
          <div className="flex gap-1">
            {([['text', 'Write or paste'], ['url', 'Import a web page'], ['file', 'Upload a file']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setD({ ...d, mode: k })} className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium ${d.mode === k ? 'bg-brand-50 text-brand-800' : 'text-slate-500 hover:bg-slate-100'}`}>{label}</button>
            ))}
          </div>
        )}
        {d.mode === 'text' && (<>
          <Field label="Title"><input className="input" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="Refund policy" autoFocus /></Field>
          <Field label="Content"><textarea className="input font-mono !text-xs" rows={14} value={d.content} onChange={(e) => setD({ ...d, content: e.target.value })} placeholder="Write the facts the agent should know…" /></Field>
        </>)}
        {d.mode === 'url' && <Field label="Page URL" hint="The readable text of the page is saved. Re-import to refresh it."><input className="input" value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://yourcompany.com/faq" autoFocus /></Field>}
        {d.mode === 'file' && <Field label="File" hint="Text, Markdown, CSV, JSON or HTML."><input ref={file} type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.htm" className="input" onChange={() => setD({ ...d, picked: true })} /></Field>}
        <div className="flex justify-end gap-2">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || (d.mode === 'text' ? !d.title.trim() || !d.content.trim() : d.mode === 'url' ? !d.url.trim() : !d.picked)}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </Modal>
  )
}
