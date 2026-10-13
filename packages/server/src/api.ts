import { createWriteStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  authenticate,
  clearSessionCookie,
  createApiToken,
  createSession,
  ensureBootstrapAdmin,
  hashPassword,
  newId,
  sessionCookie,
  tokenHash,
  verifyPassword,
  type Identity,
} from './auth.js'
import type { ServerConfig } from './config.js'
import type { BlockRow, Db, UserRow } from './db.js'
import type { CaptureQueue } from './queue.js'
import { extractReproZip, ReproError } from './repro.js'
import { assertPublicUrl, SecurityError } from './security.js'
import { checkQuota, quotaUsage, resolveQuotaForOwner, today } from './quotas.js'
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
const OPEN_API_ROUTES = new Set(['/api/health', '/api/auth/register', '/api/auth/login', '/api/auth/logout'])

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
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

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200
}

export interface ApiDeps {
  store: TaskStore
  queue: CaptureQueue
  db: Db
  config: ServerConfig
  publicDir: string
  /** true once any real auth exists (token, admin or registered users) */
  authRequired: () => boolean
}

export function createApiServer({ store, queue, db, config, publicDir, authRequired }: ApiDeps) {
  // bootstrap admin so the first login works
  ensureBootstrapAdmin(db, config)

  const buckets = new Map<string, { tokens: number; resetAt: number }>()

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for']
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim()
      if (first) return first
    }
    return req.socket.remoteAddress ?? 'unknown'
  }

  /** per-caller token bucket; authenticated callers are keyed by user id */
  function allowRequest(key: string): boolean {
    const limit = config.rateLimitPerMinute
    if (!limit || limit <= 0) return true
    const now = Date.now()
    if (buckets.size > 10_000) {
      for (const [k, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(k)
    }
    let bucket = buckets.get(key)
    if (!bucket || now > bucket.resetAt) {
      bucket = { tokens: limit, resetAt: now + 60_000 }
      buckets.set(key, bucket)
    }
    if (bucket.tokens <= 0) return false
    bucket.tokens--
    return true
  }

  const server = createServer((req, res) => {
    const started = Date.now()
    res.on('finish', () => {
      // never log query strings: they may carry ?token=
      const pathOnly = (req.url ?? '/').split('?')[0]
      console.log(`[http] ${req.method} ${pathOnly} → ${res.statusCode} (${Date.now() - started}ms)`)
    })
    void handle(req, res).catch((err) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  function userPublic(user: UserRow) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      plan: user.plan,
      createdAt: user.created_at,
    }
  }

  function identityPublic(identity: Identity) {
    return {
      userId: identity.userId,
      email: identity.email,
      name: identity.name,
      role: identity.role,
      status: identity.status,
      plan: identity.plan,
      legacy: Boolean(identity.legacy),
    }
  }

  function mePayload(identity: Identity) {
    return {
      user: identityPublic(identity),
      quota: resolveQuotaForOwner(db, identity.userId, config),
      usage: db.getUsage(identity.userId, today()),
      totals: quotaUsage(db, identity.userId),
    }
  }

  function ownsTask(identity: Identity, ownerId: string): boolean {
    return identity.role === 'admin' || identity.userId === ownerId
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (pathname === '/' && req.method === 'GET') {
      const html = await readFile(path.join(publicDir, 'index.html'), 'utf8')
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(html)
      return
    }

    const identity = authenticate(req, db, config)
    const authOn = authRequired()
    // open single-tenant mode: no token/admin/users configured
    const effective: Identity = identity ?? {
      userId: 'system',
      email: 'system',
      name: 'system',
      role: 'admin',
      status: 'active',
      plan: 'unlimited',
      legacy: true,
    }

    if (pathname.startsWith('/api/') && !allowRequest(identity?.userId ?? clientIp(req))) {
      res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60' })
      res.end(JSON.stringify({ error: 'rate limit exceeded' }))
      return
    }

    if (authOn && !identity && !OPEN_API_ROUTES.has(pathname)) {
      json(res, 401, { error: 'unauthorized — log in or send an API token' })
      return
    }

    if (identity && identity.status === 'suspended' && !identity.legacy && !pathname.startsWith('/api/auth/')) {
      json(res, 403, { error: 'account suspended' })
      return
    }

    // ---------- health ----------

    if (pathname === '/api/health') {
      const base = { ok: true }
      if (identity || !authOn) {
        json(res, 200, { ...base, tasks: store.count(), queue: queue.size, authRequired: authOn })
      } else {
        json(res, 200, base)
      }
      return
    }

    // ---------- events (SSE) ----------

    if (pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('event: hello\ndata: {}\n\n')
      const onTask = (task: { ownerId: string }) => {
        // tenants only see their own tasks; admins see everything
        if (effective.role !== 'admin' && task.ownerId !== effective.userId) return
        res.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`)
      }
      const onCleaned = (ids: string[]) => {
        res.write(`event: cleaned\ndata: ${JSON.stringify(ids)}\n\n`)
      }
      store.events.on('task', onTask)
      store.events.on('cleaned', onCleaned)
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        store.events.off('task', onTask)
        store.events.off('cleaned', onCleaned)
      })
      return
    }

    // ---------- auth ----------

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      if (!config.allowRegistration) {
        json(res, 403, { error: 'registration is disabled' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : null
      if (!validEmail(email)) {
        json(res, 400, { error: 'valid email required' })
        return
      }
      if (password.length < 8) {
        json(res, 400, { error: 'password must be at least 8 characters' })
        return
      }
      if (db.getUserByEmail(email)) {
        json(res, 409, { error: 'email already registered' })
        return
      }
      const user = db.createUser({
        id: newId(),
        email,
        name,
        password_hash: hashPassword(password),
        role: 'user',
        status: 'active',
        plan: 'free',
        quota_json: '{}',
      })
      const token = createSession(db, user.id)
      db.audit(user.id, 'user.register', { email })
      json(res, 201, { user: userPublic(user) }, { 'set-cookie': sessionCookie(token) })
      return
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const password = typeof body.password === 'string' ? body.password : ''
      const user = db.getUserByEmail(email)
      if (!user || !verifyPassword(password, user.password_hash)) {
        json(res, 401, { error: 'invalid email or password' })
        return
      }
      if (user.status === 'suspended') {
        json(res, 403, { error: 'account suspended' })
        return
      }
      const token = createSession(db, user.id)
      json(res, 200, { user: userPublic(user) }, { 'set-cookie': sessionCookie(token) })
      return
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const cookies = req.headers.cookie ?? ''
      const match = cookies.match(/(?:^|;\s*)cp_session=([^;]+)/)
      if (match) db.deleteSession(tokenHash(match[1]))
      json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() })
      return
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      json(res, 200, mePayload(effective))
      return
    }

    // ---------- api tokens ----------

    if (pathname === '/api/tokens' && req.method === 'GET') {
      json(res, 200, { tokens: db.listApiTokens(effective.userId) })
      return
    }

    if (pathname === '/api/tokens' && req.method === 'POST') {
      let name: string | null = null
      try {
        const body = (await readBody(req)) as { name?: unknown }
        if (typeof body.name === 'string') name = body.name.slice(0, 80)
      } catch {
        // body optional
      }
      const created = createApiToken(db, effective.userId, name)
      db.audit(effective.userId, 'token.create', { id: created.id })
      json(res, 201, { id: created.id, token: created.token })
      return
    }

    const tokenDelete = pathname.match(/^\/api\/tokens\/([^/]+)$/)
    if (tokenDelete && req.method === 'DELETE') {
      const removed = db.deleteApiToken(effective.userId, tokenDelete[1])
      db.audit(effective.userId, 'token.delete', { id: tokenDelete[1] })
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown token' })
      return
    }

    // ---------- admin ----------

    if (pathname.startsWith('/api/admin/')) {
      if (effective.role !== 'admin') {
        json(res, 403, { error: 'admin only' })
        return
      }
      await handleAdmin(req, res, pathname, url, effective)
      return
    }

    // ---------- tasks ----------

    if (pathname === '/api/tasks' && req.method === 'GET') {
      const scope = effective.role === 'admin' ? undefined : effective.userId
      json(res, 200, { tasks: store.list(scope), queue: queue.size })
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
      const quota = checkQuota(db, effective, 'capture', config)
      if (!quota.ok) {
        json(res, 403, { error: quota.message, code: quota.code, quota: quota.quota, usage: quota.usage })
        return
      }
      if (store.count() >= config.maxTasks) {
        json(res, 507, { error: `server task limit reached (${config.maxTasks})` })
        return
      }
      if (type === 'url') {
        try {
          await assertPublicUrl(source, { allowPrivateNetwork: config.allowPrivateNetwork })
        } catch (err) {
          json(res, 400, { error: err instanceof SecurityError ? err.message : String(err) })
          return
        }
        const host = new URL(source).hostname
        if (db.isDomainBlocked(host)) {
          json(res, 403, { error: `domain blocked by moderation: ${host}` })
          return
        }
      }
      const task = await store.create(effective.userId, { type, source }, sanitizeOptions(input.options))
      if (!effective.legacy) db.incrUsage(effective.userId, 'capture', today())
      queue.enqueue({ kind: 'capture', taskId: task.id, ownerId: effective.userId })
      json(res, 201, { task })
      return
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (taskMatch && req.method === 'GET') {
      const task = store.get(taskMatch[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      json(res, 200, { task })
      return
    }

    if (taskMatch && req.method === 'DELETE') {
      const task = store.get(taskMatch[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      if (task.status === 'running' || task.status === 'queued') {
        json(res, 409, { error: 'task is still running' })
        return
      }
      await store.delete(task.id)
      db.audit(effective.userId, 'task.delete', { taskId: task.id, owner: task.ownerId })
      json(res, 200, { ok: true })
      return
    }

    const verifyMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/verifications$/)
    if (verifyMatch && req.method === 'POST') {
      await createVerification(req, res, verifyMatch[1], effective)
      return
    }

    const generateMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/generate$/)
    if (generateMatch && req.method === 'POST') {
      const task = store.get(generateMatch[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      if (task.status !== 'done' || !task.result) {
        json(res, 409, { error: 'capture must finish before generating' })
        return
      }
      if (!config.allowAgent) {
        json(res, 403, { error: 'agent generation is disabled — start the server with --allow-agent' })
        return
      }
      const quota = checkQuota(db, effective, 'generate', config)
      if (!quota.ok) {
        json(res, 403, { error: quota.message, code: quota.code, quota: quota.quota, usage: quota.usage })
        return
      }
      const generation = await store.createGeneration(task.id, {
        reproDir: path.join(store.taskDir(task.id), 'generated-repro'),
        sessionId: `gen-${task.id}-${Date.now().toString(36)}`,
        command: config.agentCommand,
        ...(config.agentModel ? { model: config.agentModel } : {}),
      })
      if (!effective.legacy) db.incrUsage(effective.userId, 'generate', today())
      queue.enqueue({ kind: 'generate', taskId: task.id, ownerId: task.ownerId, generationId: generation.id })
      json(res, 201, { task: store.get(task.id), generation })
      return
    }

    const files = pathname.match(/^\/api\/tasks\/([^/]+)\/files\/(.+)$/)
    if (files && req.method === 'GET') {
      const task = store.get(files[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      await serveFile(res, store.taskDir(files[1]), decodeURIComponent(files[2]))
      return
    }

    const artifacts = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/(.+)$/)
    if (artifacts && req.method === 'GET') {
      const task = store.get(artifacts[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      await serveFile(res, store.snapshotDir(artifacts[1]), decodeURIComponent(artifacts[2]))
      return
    }

    json(res, 404, { error: 'not found' })
  }

  // ---------- verification creation ----------

  async function createVerification(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
    identity: Identity,
  ): Promise<void> {
    const task = store.get(taskId)
    if (!task || !ownsTask(identity, task.ownerId)) {
      json(res, 404, { error: 'unknown task' })
      return
    }
    if (task.status !== 'done' || !task.result) {
      json(res, 409, { error: 'capture must finish before verifying' })
      return
    }
    const quota = checkQuota(db, identity, 'verify', config)
    if (!quota.ok) {
      json(res, 403, { error: quota.message, code: quota.code, quota: quota.quota, usage: quota.usage })
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
      if (!identity.legacy) db.incrUsage(identity.userId, 'verify', today())
      queue.enqueue({ kind: 'verify', taskId, ownerId: task.ownerId, verificationId: verification.id })
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
    // NOTE: server-local paths are only allowed for admins; regular tenants
    // must upload a zip so they cannot read the host filesystem
    if (identity.role !== 'admin') {
      json(res, 403, { error: 'path-based verification is admin-only — upload a zip instead' })
      return
    }
    const verification = await store.createVerification(
      taskId,
      { type: 'path', source: reproDir },
      reproDir,
    )
    if (!identity.legacy) db.incrUsage(identity.userId, 'verify', today())
    queue.enqueue({ kind: 'verify', taskId, ownerId: task.ownerId, verificationId: verification.id })
    json(res, 201, { task: store.get(taskId), verification })
  }

  // ---------- admin ----------

  async function handleAdmin(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: URL,
    identity: Identity,
  ): Promise<void> {
    if (pathname === '/api/admin/users' && req.method === 'GET') {
      const users = db.listUsers().map((user) => ({
        ...userPublic(user),
        quota: resolveQuotaForOwner(db, user.id, config),
        totals: quotaUsage(db, user.id),
      }))
      json(res, 200, { users })
      return
    }

    const userPatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (userPatch && req.method === 'PATCH') {
      const user = db.getUserById(userPatch[1])
      if (!user) {
        json(res, 404, { error: 'unknown user' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const patch: Parameters<Db['updateUser']>[1] = {}
      if (body.status === 'active' || body.status === 'suspended') patch.status = body.status
      if (typeof body.plan === 'string' && body.plan in config.plans) patch.plan = body.plan
      if (body.quota && typeof body.quota === 'object') patch.quota_json = JSON.stringify(body.quota)
      if (typeof body.password === 'string' && body.password.length >= 8) {
        patch.password_hash = hashPassword(body.password)
      }
      const updated = db.updateUser(user.id, patch)
      db.audit(identity.userId, 'admin.user.update', { userId: user.id, patch: { ...patch, password_hash: undefined } })
      json(res, 200, { user: updated ? userPublic(updated) : null })
      return
    }

    if (pathname === '/api/admin/blocks' && req.method === 'GET') {
      json(res, 200, { blocks: db.listBlocks() })
      return
    }

    if (pathname === '/api/admin/blocks' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const kind = body.kind === 'user' ? 'user' : 'domain'
      const value = typeof body.value === 'string' ? body.value.trim().toLowerCase() : ''
      if (!value) {
        json(res, 400, { error: 'value required' })
        return
      }
      const block: BlockRow = {
        id: newId(),
        kind,
        value,
        note: typeof body.note === 'string' ? body.note.slice(0, 200) : null,
        created_at: new Date().toISOString(),
      }
      db.addBlock(block)
      db.audit(identity.userId, 'admin.block.add', block)
      json(res, 201, { block })
      return
    }

    const blockDelete = pathname.match(/^\/api\/admin\/blocks\/([^/]+)$/)
    if (blockDelete && req.method === 'DELETE') {
      const removed = db.removeBlock(blockDelete[1])
      db.audit(identity.userId, 'admin.block.remove', { id: blockDelete[1] })
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown block' })
      return
    }

    if (pathname === '/api/admin/audit' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 1000)
      json(res, 200, { entries: db.listAudit(limit) })
      return
    }

    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      const users = db.listUsers()
      json(res, 200, {
        users: users.length,
        suspended: users.filter((u) => u.status === 'suspended').length,
        tasks: store.count(),
        storageBytes: db.sumStorage(),
        queue: queue.size,
        sessions: users.length ? undefined : 0,
      })
      return
    }

    json(res, 404, { error: 'not found' })
  }

  // ---------- files ----------

  async function serveFile(res: ServerResponse, root: string, rel: string): Promise<void> {
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
