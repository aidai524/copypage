import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createWriteStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CaptureQueue } from './queue.js'
import type { ServerConfig } from './config.js'
import { extractReproZip, ReproError } from './repro.js'
import { assertPublicUrl, SecurityError, tokenMatches } from './security.js'
import type { TaskStore } from './store.js'
import type { CaptureJobOptions, TaskInputType } from './types.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const MAX_BODY_BYTES = 1_000_000
const INPUT_TYPES: TaskInputType[] = ['url', 'image', 'video']

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Stream a possibly-large request body to disk with a hard size cap. */
async function saveBodyToFile(req: IncomingMessage, file: string, maxBytes: number): Promise<number> {
  let total = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length
      if (total > maxBytes) cb(new Error(`body larger than ${Math.round(maxBytes / 1024 / 1024)}MB`))
      else cb(null, chunk)
    },
  })
  await pipeline(req, counter, createWriteStream(file))
  return total
}

function sanitizeOptions(raw: unknown): CaptureJobOptions {
  const src = (raw ?? {}) as Record<string, unknown>
  const out: CaptureJobOptions = {}
  if (Array.isArray(src.viewports)) {
    const widths = src.viewports
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 320 && v <= 3840)
      .slice(0, 5)
    if (widths.length > 0) out.viewports = widths
  }
  if (typeof src.maxNodes === 'number' && Number.isFinite(src.maxNodes)) {
    out.maxNodes = Math.min(Math.max(Math.round(src.maxNodes), 500), 50_000)
  }
  if (typeof src.states === 'boolean') out.states = src.states
  if (typeof src.dynamic === 'boolean') out.dynamic = src.dynamic
  if (typeof src.dynamicDurationMs === 'number' && Number.isFinite(src.dynamicDurationMs)) {
    out.dynamicDurationMs = Math.min(Math.max(Math.round(src.dynamicDurationMs), 500), 15_000)
  }
  if (typeof src.assetsBudgetMs === 'number' && Number.isFinite(src.assetsBudgetMs)) {
    out.assetsBudgetMs = Math.min(Math.max(Math.round(src.assetsBudgetMs), 5_000), 600_000)
  }
  return out
}

export interface ApiDeps {
  store: TaskStore
  queue: CaptureQueue
  publicDir: string
  config: ServerConfig
}

export function createApiServer({ store, queue, publicDir, config }: ApiDeps) {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  /** bearer header, or ?token= for EventSource (which cannot set headers) */
  function authorized(req: IncomingMessage, url: URL): boolean {
    if (!config.token) return true
    const header = req.headers.authorization
    const provided = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (url.searchParams.get('token') ?? '')
    return provided.length > 0 && tokenMatches(provided, config.token)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (pathname.startsWith('/api/') && !authorized(req, url)) {
      json(res, 401, { error: 'unauthorized — send Authorization: Bearer <token>' })
      return
    }

    if (pathname === '/' && req.method === 'GET') {
      const html = await readFile(path.join(publicDir, 'index.html'), 'utf8')
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(html)
      return
    }

    if (pathname === '/api/health') {
      json(res, 200, { ok: true, tasks: store.list().length, queue: queue.size })
      return
    }

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('event: hello\ndata: {}\n\n')
      const onTask = (task: unknown) => {
        res.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`)
      }
      store.events.on('task', onTask)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        store.events.off('task', onTask)
      })
      return
    }

    if (pathname === '/api/tasks' && req.method === 'GET') {
      json(res, 200, { tasks: store.list(), queue: queue.size })
      return
    }

    if (pathname === '/api/tasks' && req.method === 'POST') {
      let body: unknown
      try {
        body = await readBody(req)
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const input = (body ?? {}) as Record<string, unknown>
      const type = input.type as TaskInputType
      const source = typeof input.source === 'string' ? input.source.trim() : ''
      if (!INPUT_TYPES.includes(type) || !source) {
        json(res, 400, { error: 'type must be url|image|video and source must be non-empty' })
        return
      }
      if (store.list().length >= config.maxTasks) {
        json(res, 507, {
          error: `task limit reached (${config.maxTasks}); wait for retention cleanup`,
        })
        return
      }
      if (type === 'url') {
        try {
          await assertPublicUrl(source, { allowPrivateNetwork: config.allowPrivateNetwork })
        } catch (err) {
          json(res, 400, { error: err instanceof SecurityError ? err.message : String(err) })
          return
        }
      }
      const task = await store.create({ type, source }, sanitizeOptions(input.options))
      queue.enqueue({ kind: 'capture', taskId: task.id })
      json(res, 201, { task })
      return
    }

    // create a verification for an existing capture: JSON {repro:{type:'path'|'zip',source}}
    // or a raw zip upload (content-type: application/zip)
    const verify = pathname.match(/^\/api\/tasks\/([^/]+)\/verifications$/)
    if (verify && req.method === 'POST') {
      await createVerification(req, res, verify[1])
      return
    }

    const files = pathname.match(/^\/api\/tasks\/([^/]+)\/files\/(.+)$/)
    if (files && req.method === 'GET') {
      await serveFile(res, store.taskDir(files[1]), decodeURIComponent(files[2]), files[1])
      return
    }

    const artifacts = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/(.+)$/)
    if (artifacts && req.method === 'GET') {
      await serveFile(res, store.snapshotDir(artifacts[1]), decodeURIComponent(artifacts[2]), artifacts[1])
      return
    }

    const one = pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (one && req.method === 'GET') {
      const task = store.get(one[1])
      if (!task) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      json(res, 200, { task })
      return
    }

    json(res, 404, { error: 'not found' })
  }

  async function createVerification(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
  ): Promise<void> {
    const task = store.get(taskId)
    if (!task) {
      json(res, 404, { error: 'unknown task' })
      return
    }
    if (task.status !== 'done' || !task.result) {
      json(res, 409, { error: 'capture must finish before verifying' })
      return
    }

    const contentType = req.headers['content-type'] ?? ''
    if (contentType.includes('application/zip') || contentType.includes('application/octet-stream')) {
      const verification = await store.createVerification(taskId, { type: 'zip', source: 'upload.zip' }, '')
      const verDir = store.verificationDir(taskId, verification.id)
      const zipPath = path.join(verDir, 'upload.zip')
      try {
        await saveBodyToFile(req, zipPath, config.maxUploadBytes)
        const reproDir = await extractReproZip(zipPath, path.join(verDir, 'repro'))
        await store.updateVerification(taskId, verification.id, {
          reproDir,
          repro: { type: 'zip', source: String(req.headers['x-filename'] ?? 'upload.zip').slice(0, 200) },
        })
      } catch (err) {
        const message = err instanceof ReproError || err instanceof Error ? err.message : String(err)
        await store.updateVerification(taskId, verification.id, { status: 'failed', error: message })
        json(res, 400, { error: message })
        return
      }
      queue.enqueue({ kind: 'verify', taskId, verificationId: verification.id })
      const latest = store.get(taskId)!.verifications.find((v) => v.id === verification.id) ?? verification
      json(res, 201, { task: store.get(taskId), verification: latest })
      return
    }

    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      json(res, 400, { error: 'invalid JSON body' })
      return
    }
    const repro = ((body ?? {}) as Record<string, unknown>).repro as
      | { type?: string; source?: string }
      | undefined
    const source = typeof repro?.source === 'string' ? repro.source.trim() : ''
    if (!source) {
      json(res, 400, { error: 'repro.source (server-local path) is required' })
      return
    }
    const reproDir = path.resolve(source)
    const info = await stat(reproDir).catch(() => null)
    if (!info?.isDirectory()) {
      json(res, 400, { error: `repro path is not a directory: ${source}` })
      return
    }
    // NOTE: server-local paths are allowed by design in the single-tenant
    // phase; public deployments must constrain this + add auth (Phase 4)
    const verification = await store.createVerification(
      taskId,
      { type: 'path', source: reproDir },
      reproDir,
    )
    queue.enqueue({ kind: 'verify', taskId, verificationId: verification.id })
    json(res, 201, { task: store.get(taskId), verification })
  }

  async function serveFile(
    res: ServerResponse,
    root: string,
    rel: string,
    taskId: string,
  ): Promise<void> {
    if (!store.get(taskId)) {
      json(res, 404, { error: 'unknown task' })
      return
    }
    const resolvedRoot = path.resolve(root)
    const full = path.resolve(resolvedRoot, rel)
    if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    const info = await stat(full).catch(() => null)
    if (!info || !info.isFile()) {
      json(res, 404, { error: 'file not found' })
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
    })
    res.end(await readFile(full))
  }

  return server
}
