import path from 'node:path'
import fs from 'node:fs'
import QRCode from 'qrcode'
import pino from 'pino'
import { DATA_DIR, token } from './db.js'

export type Incoming = {
  waId: string; jid: string; chatType: 'dm' | 'group'; chatName?: string; phone?: string
  senderJid?: string; senderName?: string; fromMe: boolean
  type: string; text: string; media?: { buffer: Buffer; mime: string; name?: string }; timestamp: number
}
export type TransportHandlers = {
  onStatus: (status: string, extra?: { qr?: string | null; phone?: string }) => void
  onMessage: (m: Incoming) => void
  onReceipt: (waId: string, status: 'sent' | 'delivered' | 'read') => void
}
export interface Transport {
  start(): Promise<void>
  stop(): Promise<void>
  logout(): Promise<void>
  sendText(jid: string, text: string): Promise<string>
  sendMedia(jid: string, media: { buffer: Buffer; mime: string; name?: string }, caption?: string): Promise<string>
  resolveJid(phone: string): Promise<string>
  pairingCode(phone: string): Promise<string>
}

/** A simulated number: no phone required. Used for trying the product and by the QA suite. */
export class SandboxTransport implements Transport {
  constructor(private h: TransportHandlers) {}
  async start() { this.h.onStatus('connected', { phone: 'sandbox' }) }
  async stop() {}
  async logout() { this.h.onStatus('disconnected') }
  private ack() {
    const waId = `sbx_${token(8)}`
    setTimeout(() => this.h.onReceipt(waId, 'delivered'), 30)
    return waId
  }
  async sendText() { return this.ack() }
  async sendMedia() { return this.ack() }
  async resolveJid(phone: string) { return `${phone.replace(/\D/g, '')}@s.whatsapp.net` }
  async pairingCode(): Promise<string> { throw new Error('Sandbox numbers do not need pairing') }
  /** Inject a message as if a customer sent it. */
  simulate(m: { from: string; name?: string; text: string; group?: string }) {
    const digits = m.from.replace(/\D/g, '')
    const senderJid = `${digits}@s.whatsapp.net`
    const groupJid = m.group ? `${m.group.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@g.us` : undefined
    this.h.onMessage({
      waId: `sbxin_${token(8)}`, jid: groupJid || senderJid, chatType: groupJid ? 'group' : 'dm',
      chatName: m.group || m.name, phone: groupJid ? undefined : digits, senderJid, senderName: m.name || digits,
      fromMe: false, type: 'text', text: m.text, timestamp: Date.now(),
    })
  }
}

/** A real WhatsApp number linked as a companion device (QR code or pairing code), via Baileys. */
export class BaileysTransport implements Transport {
  private sock: any
  private stopped = false
  private retries = 0
  private groupNames = new Map<string, string>()
  private authDir: string
  constructor(private numberId: string, private h: TransportHandlers) {
    this.authDir = path.join(DATA_DIR, 'wa-auth', numberId)
  }

  async start() {
    this.stopped = false
    const b = await import('baileys')
    const { state, saveCreds } = await b.useMultiFileAuthState(this.authDir)
    const logger = pino({ level: 'silent' })
    let agent: any
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    if (proxy) agent = new (await import('https-proxy-agent')).HttpsProxyAgent(proxy)
    let version: any
    try { version = (await b.fetchLatestBaileysVersion()).version } catch { /* use bundled default */ }

    const sock = (this.sock = b.makeWASocket({
      auth: { creds: state.creds, keys: b.makeCacheableSignalKeyStore(state.keys, logger as any) },
      logger: logger as any, browser: b.Browsers.macOS('Desktop'), markOnlineOnConnect: false,
      syncFullHistory: false, agent, ...(version ? { version } : {}),
    }))
    this.h.onStatus('connecting')
    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (u: any) => {
      if (u.qr) this.h.onStatus('qr', { qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }) })
      if (u.connection === 'open') {
        this.retries = 0
        this.h.onStatus('connected', { phone: String(sock.user?.id || '').split(/[:@]/)[0], qr: null })
      }
      if (u.connection === 'close') {
        if (this.stopped || this.sock !== sock) return
        const code = u.lastDisconnect?.error?.output?.statusCode
        if (code === b.DisconnectReason.loggedOut) {
          fs.rmSync(this.authDir, { recursive: true, force: true })
          this.h.onStatus('disconnected', { qr: null })
          return
        }
        this.h.onStatus('connecting')
        const delay = Math.min(30000, 1000 * 2 ** this.retries++)
        setTimeout(() => { if (!this.stopped) this.start().catch(() => {}) }, delay)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      if (type !== 'notify') return
      for (const m of messages) {
        try { await this.handle(b, sock, m) } catch (e) { console.error('[wa] failed to process message', e) }
      }
    })

    sock.ev.on('messages.update', (updates: any[]) => {
      for (const u of updates) {
        const s = u.update?.status
        if (!u.key?.id || !u.key.fromMe || !s) continue
        this.h.onReceipt(u.key.id, s >= 4 ? 'read' : s === 3 ? 'delivered' : 'sent')
      }
    })
  }

  private async handle(b: any, sock: any, m: any) {
    const jid: string | undefined = m.key?.remoteJid
    if (!jid || !m.message || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return
    const content = b.normalizeMessageContent(m.message)
    const kind = b.getContentType(content)
    if (!kind || kind === 'protocolMessage' || kind === 'senderKeyDistributionMessage' || kind === 'reactionMessage') return
    const c: any = content[kind]
    const isGroup = !!b.isJidGroup(jid)

    const typeMap: Record<string, string> = {
      conversation: 'text', extendedTextMessage: 'text', imageMessage: 'image', videoMessage: 'video',
      audioMessage: 'audio', documentMessage: 'document', stickerMessage: 'sticker',
    }
    const type = typeMap[kind] || 'other'
    const text: string = typeof c === 'string' ? c : c?.text || c?.caption || ''

    let media: Incoming['media']
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(type)) {
      try {
        const buffer = (await b.downloadMediaMessage(m, 'buffer', {})) as Buffer
        if (buffer.length <= 30 * 1024 * 1024) media = { buffer, mime: c?.mimetype || 'application/octet-stream', name: c?.fileName }
      } catch { /* media expired or unreachable: keep the message without the file */ }
    }

    let chatName: string | undefined = m.pushName
    if (isGroup) {
      if (!this.groupNames.has(jid)) {
        try { this.groupNames.set(jid, (await sock.groupMetadata(jid)).subject) } catch { this.groupNames.set(jid, 'Group') }
      }
      chatName = this.groupNames.get(jid)
    }
    const pn = [jid, m.key.remoteJidAlt].find((j: string | undefined) => j?.endsWith('@s.whatsapp.net'))
    this.h.onMessage({
      waId: m.key.id, jid, chatType: isGroup ? 'group' : 'dm', chatName: m.key.fromMe && !isGroup ? undefined : chatName,
      phone: isGroup ? undefined : pn?.split('@')[0],
      senderJid: isGroup ? m.key.participant : jid, senderName: m.pushName, fromMe: !!m.key.fromMe,
      type, text: text || (type === 'other' ? '[unsupported message]' : ''), media,
      timestamp: Number(m.messageTimestamp || 0) * 1000 || Date.now(),
    })
  }

  private ready() {
    if (!this.sock?.user) throw new Error('WhatsApp number is not connected')
    return this.sock
  }
  async sendText(jid: string, text: string) {
    return (await this.ready().sendMessage(jid, { text })).key.id as string
  }
  async sendMedia(jid: string, media: { buffer: Buffer; mime: string; name?: string }, caption?: string) {
    const kind = media.mime.startsWith('image/') ? 'image' : media.mime.startsWith('video/') ? 'video' : media.mime.startsWith('audio/') ? 'audio' : 'document'
    const msg: any = { [kind]: media.buffer, mimetype: media.mime }
    if (kind === 'document') msg.fileName = media.name || 'file'
    if (caption && kind !== 'audio') msg.caption = caption
    return (await this.ready().sendMessage(jid, msg)).key.id as string
  }
  async resolveJid(phone: string) {
    const digits = phone.replace(/\D/g, '')
    const [r] = (await this.ready().onWhatsApp(digits)) || []
    if (!r?.exists) throw new Error(`${phone} is not on WhatsApp`)
    return r.jid as string
  }
  async pairingCode(phone: string) {
    if (!this.sock) throw new Error('Start the connection first')
    return this.sock.requestPairingCode(phone.replace(/\D/g, ''))
  }
  async stop() {
    this.stopped = true
    try { this.sock?.end(undefined) } catch { /* already closed */ }
    this.sock = undefined
  }
  async logout() {
    this.stopped = true
    try { await this.sock?.logout() } catch { /* not connected */ }
    this.sock = undefined
    fs.rmSync(this.authDir, { recursive: true, force: true })
    this.h.onStatus('disconnected', { qr: null })
  }
}
