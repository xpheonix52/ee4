import { db, id, now } from './db.js'

function chunk(text: string, size = 900) {
  const out: string[] = []
  let cur = ''
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim()
    if (!p) continue
    if (cur && cur.length + p.length > size) { out.push(cur); cur = '' }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) out.push(p.slice(i, i + size))
    } else cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur) out.push(cur)
  return out
}
function index(docId: string, title: string, content: string) {
  db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId)
  const ins = db.prepare('INSERT INTO kb_chunks(doc_id, title, body) VALUES(?,?,?)')
  for (const c of chunk(content)) ins.run(docId, title, c)
}

export const listDocs = () => db.prepare('SELECT id, title, source, url, length(content) AS size, created_at, updated_at FROM kb_docs ORDER BY updated_at DESC').all()
export const getDoc = (docId: string) => db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(docId) as any

export function addDoc(d: { title: string; content: string; source?: string; url?: string }) {
  const docId = id('doc')
  db.prepare('INSERT INTO kb_docs(id, title, source, url, content, created_at, updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(docId, d.title, d.source || 'text', d.url ?? null, d.content, now(), now())
  index(docId, d.title, d.content)
  return getDoc(docId)
}
export function updateDoc(docId: string, d: { title?: string; content?: string }) {
  const cur = getDoc(docId)
  if (!cur) return null
  const title = d.title ?? cur.title
  const content = d.content ?? cur.content
  db.prepare('UPDATE kb_docs SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(title, content, now(), docId)
  index(docId, title, content)
  return getDoc(docId)
}
export function deleteDoc(docId: string) {
  db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId)
  db.prepare('DELETE FROM kb_docs WHERE id = ?').run(docId)
}

export function searchKnowledge(query: string, limit = 5) {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 24)
  if (!terms.length) return []
  const match = terms.map((t) => `"${t}"`).join(' OR ')
  return db.prepare('SELECT doc_id, title, body, bm25(kb_chunks, 0, 4.0, 1.0) AS score FROM kb_chunks WHERE kb_chunks MATCH ? ORDER BY score LIMIT ?')
    .all(match, limit) as { doc_id: string; title: string; body: string; score: number }[]
}

export function htmlToText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
}
export async function importUrl(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Switchboard)' }, signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`Could not fetch page (HTTP ${res.status})`)
  const raw = await res.text()
  const isHtml = (res.headers.get('content-type') || '').includes('html') || /<html/i.test(raw)
  const title = (raw.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || url).trim()
  const content = isHtml ? htmlToText(raw) : raw
  if (!content) throw new Error('No readable text found at that URL')
  return addDoc({ title, content, source: 'url', url })
}
