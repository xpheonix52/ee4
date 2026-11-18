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

// ---------- FAQs: question variations, one answer, optional handling instructions ----------
export type Faq = { id: string; questions: string[]; answer: string; instructions: string | null; status: 'active' | 'review' | 'disabled'; source: 'manual' | 'learned'; created_at: number; updated_at: number }
const faqView = (r: any): Faq => ({ ...r, questions: JSON.parse(r.questions) })
function indexFaq(f: Faq) {
  db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(f.id)
  // Only approved entries are searchable, so the agent never uses something a person has not accepted.
  if (f.status !== 'active') return
  const body = `Customer question: ${f.questions.join(' / ')}\nAnswer: ${f.answer}${f.instructions ? `\nHow to handle (internal, do not quote): ${f.instructions}` : ''}`
  db.prepare('INSERT INTO kb_chunks(doc_id, title, body) VALUES(?,?,?)').run(f.id, `FAQ: ${f.questions.join(' ')}`, body)
}
export const listFaqs = () => (db.prepare('SELECT * FROM kb_faqs ORDER BY (status = \'review\') DESC, updated_at DESC').all() as any[]).map(faqView)
export const getFaq = (faqId: string) => { const r = db.prepare('SELECT * FROM kb_faqs WHERE id = ?').get(faqId); return r ? faqView(r) : null }
const cleanQuestions = (q: unknown) => (Array.isArray(q) ? q : String(q || '').split('\n')).map((x) => String(x).trim()).filter(Boolean)
export function saveFaq(input: { questions?: unknown; answer?: string; instructions?: string | null; status?: string; source?: string }, faqId?: string) {
  const cur = faqId ? getFaq(faqId) : null
  const questions = input.questions !== undefined ? cleanQuestions(input.questions) : cur?.questions || []
  const answer = (input.answer ?? cur?.answer ?? '').trim()
  if (!questions.length || !answer) throw new Error('An FAQ needs at least one question and an answer')
  const status = ['active', 'review', 'disabled'].includes(input.status || '') ? input.status! : cur?.status || 'active'
  const row = { id: cur?.id || id('faq'), questions: JSON.stringify(questions), answer, instructions: (input.instructions ?? cur?.instructions ?? '') || null, status, source: cur?.source || (input.source === 'learned' ? 'learned' : 'manual') }
  if (cur) db.prepare('UPDATE kb_faqs SET questions=?, answer=?, instructions=?, status=?, updated_at=? WHERE id=?').run(row.questions, row.answer, row.instructions, row.status, now(), row.id)
  else db.prepare('INSERT INTO kb_faqs(id, questions, answer, instructions, status, source, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id, row.questions, row.answer, row.instructions, row.status, row.source, now(), now())
  const saved = getFaq(row.id)!
  indexFaq(saved)
  return saved
}
export function deleteFaq(faqId: string) {
  db.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(faqId)
  db.prepare('DELETE FROM kb_faqs WHERE id = ?').run(faqId)
}

export async function pdfToText(buffer: Buffer) {
  const { extractText } = await import('unpdf')
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true })
  return String(text || '').trim()
}
