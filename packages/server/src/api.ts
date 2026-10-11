import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CaptureQueue } from './queue.js'
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
}

export function createApiServer({ store, queue, publicDir }: ApiDeps) {
  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

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
      const task = await store.create({ type, source }, sanitizeOptions(input.options))
      queue.enqueue(task.id)
      json(res, 201, { task })
      return
    }

    const artifacts = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/(.+)$/)
    if (artifacts && req.method === 'GET') {
      await serveArtifact(req, res, artifacts[1], decodeURIComponent(artifacts[2]))
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

  async function serveArtifact(
    _req: IncomingMessage,
    res: ServerResponse,
    id: string,
    rel: string,
  ): Promise<void> {
    if (!store.get(id)) {
      json(res, 404, { error: 'unknown task' })
      return
    }
    const root = path.resolve(store.snapshotDir(id))
    const full = path.resolve(root, rel)
    if (full !== root && !full.startsWith(root + path.sep)) {
      json(res, 403, { error: 'forbidden' })
      return
    }
    const info = await stat(full).catch(() => null)
    if (!info || !info.isFile()) {
      json(res, 404, { error: 'artifact not found' })
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
