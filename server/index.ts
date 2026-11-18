import express, { type Request, type Response, type NextFunction } from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { api, HttpError, resolveActor } from './routes.js'
import { handleMcp } from './mcp.js'
import { startAllNumbers } from './core.js'
import { startBackground } from './background.js'

const app = express()
app.set('trust proxy', true)
app.use(express.json({ limit: '5mb' }))
app.use(cookieParser())

app.get('/healthz', (_req, res) => { res.json({ ok: true }) })
app.use('/api/v1', api)

app.post('/mcp', async (req, res) => {
  if (!resolveActor(req)) { res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send "Authorization: Bearer <api key>" or add ?key=<api key> to the URL' }, id: null }); return }
  await handleMcp(req, res)
})
app.all('/mcp', (_req, res) => { res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null }) })

app.use('/api', (_req, res) => { res.status(404).json({ error: 'Unknown API route' }) })

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web')
if (fs.existsSync(path.join(webDir, 'index.html'))) {
  app.use(express.static(webDir, { index: false, maxAge: '1h' }))
  app.get(/.*/, (_req, res) => { res.setHeader('cache-control', 'no-cache'); res.sendFile(path.join(webDir, 'index.html')) })
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err?.status || (err?.code === 'LIMIT_FILE_SIZE' ? 413 : 500)
  if (status >= 500) console.error(err)
  if (!res.headersSent) res.status(status).json({ error: err?.message || 'Something went wrong on the server' })
})

process.on('unhandledRejection', (e) => console.error('[unhandled]', e))

const port = Number(process.env.PORT) || 3000
app.listen(port, () => {
  console.log(`Switchboard running on http://localhost:${port}`)
  startBackground()
  startAllNumbers()
})
