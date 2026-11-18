import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { db, DATA_DIR, localNow } from './db.js'

const run = promisify(execFile)
export const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const KEEP = 14
const NAME = /^switchboard-[\w.-]+\.tar\.gz$/

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return []
  return fs.readdirSync(BACKUP_DIR).filter((f) => NAME.test(f)).map((name) => {
    const st = fs.statSync(path.join(BACKUP_DIR, name))
    return { name, size: st.size, created_at: st.mtimeMs, includes_media: name.includes('-full') }
  }).sort((a, b) => b.created_at - a.created_at)
}
export const backupPath = (name: string) => (NAME.test(name) && fs.existsSync(path.join(BACKUP_DIR, name)) ? path.join(BACKUP_DIR, name) : null)

let running: Promise<ReturnType<typeof listBackups>[number]> | null = null
/**
 * One archive with everything needed to rebuild the workspace elsewhere: a consistent copy of the
 * database (chats, automations, knowledge, settings, team) and the WhatsApp logins. Attachments are
 * large, so they are only included when asked for.
 */
export function createBackup(opts: { media?: boolean } = {}) {
  running ??= (async () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const name = `switchboard-${stamp}${opts.media ? '-full' : ''}.tar.gz`
    const tmp = fs.mkdtempSync(path.join(BACKUP_DIR, '.tmp-'))
    try {
      await db.backup(path.join(tmp, 'switchboard.db')) // safe while the app keeps running
      const parts = ['-C', tmp, 'switchboard.db']
      if (fs.existsSync(path.join(DATA_DIR, 'wa-auth'))) parts.push('-C', DATA_DIR, 'wa-auth')
      if (opts.media && fs.existsSync(path.join(DATA_DIR, 'media'))) parts.push('-C', DATA_DIR, 'media')
      await run('tar', ['-czf', path.join(BACKUP_DIR, name), ...parts])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
    for (const old of listBackups().slice(KEEP)) fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true })
    return listBackups().find((b) => b.name === name)!
  })().finally(() => { running = null })
  return running
}

/** Nightly, after 03:00 workspace time, if today has no backup yet. */
export async function maybeNightlyBackup() {
  const local = localNow()
  if (local.getUTCHours() < 3) return
  const today = local.toISOString().slice(0, 10)
  const offset = local.getTime() - Date.now()
  if (listBackups().some((b) => new Date(b.created_at + offset).toISOString().slice(0, 10) === today)) return
  await createBackup()
}
