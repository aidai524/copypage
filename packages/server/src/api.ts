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
  newToken,
  sessionCookie,
  tokenHash,
  verifyPassword,
  type Identity,
} from './auth.js'
import type { ServerConfig } from './config.js'
import type { BlockRow, Db, UserRow } from './db.js'
import { alertEmail, resetEmail, verificationEmail, warningEmail, type EmailClient } from './email.js'
import { maybeQuotaWarning, warnUser, type WarningKind } from './warnings.js'
import type { Metrics } from './metrics.js'
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
// endpoints reachable without a session: token-based flows arrive from email
const OPEN_API_ROUTES = new Set([
  '/api/health',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/verify-email',
  '/api/auth/resend-verification',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
])

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
  authRequired: () => Promise<boolean>
  /** mail transport (Resend when configured, stdout otherwise) */
  email: EmailClient
  metrics: Metrics
}

export function createApiServer({ store, queue, db, config, publicDir, authRequired, email, metrics }: ApiDeps) {
  // bootstrap admin so the first login works
  void ensureBootstrapAdmin(db, config)

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

  /** collapse ids so metric labels stay low-cardinality */
  function normalizeRoute(pathname: string): string {
    return pathname
      .replace(/^\/api\/tasks\/[^/]+/, '/api/tasks/:id')
      .replace(/^\/api\/admin\/users\/[^/]+/, '/api/admin/users/:id')
      .replace(/^\/api\/admin\/blocks\/[^/]+/, '/api/admin/blocks/:id')
      .replace(/^\/api\/admin\/warnings\/[^/]+/, '/api/admin/warnings/:id')
      .replace(/^\/api\/tokens\/[^/]+/, '/api/tokens/:id')
      .replace(/^\/api\/warnings\/[^/]+/, '/api/warnings/:id')
  }

  const server = createServer((req, res) => {
    const started = Date.now()
    res.on('finish', () => {
      // never log query strings: they may carry ?token=
      const pathOnly = (req.url ?? '/').split('?')[0]
      const durationMs = Date.now() - started
      metrics.inc('copypage_http_requests_total', {
        method: req.method ?? 'GET',
        route: normalizeRoute(pathOnly),
        status: res.statusCode,
      })
      metrics.observe('copypage_http_request_duration_seconds', durationMs / 1000)
      if (config.logFormat === 'json') {
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            method: req.method,
            path: pathOnly,
            status: res.statusCode,
            durationMs,
            ip: clientIp(req),
          }),
        )
      } else {
        console.log(`[http] ${req.method} ${pathOnly} → ${res.statusCode} (${durationMs}ms)`)
      }
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
      emailVerified: Boolean(user.email_verified),
      createdAt: user.created_at,
    }
  }

  /** create a one-time email token (invalidating older ones of the same kind) */
  async function issueEmailToken(userId: string, kind: 'verify_email' | 'reset_password', ttlMs: number): Promise<string> {
    const token = newToken()
    await db.deleteEmailTokens(userId, kind)
    await db.createEmailToken({
      id: newId(),
      user_id: userId,
      kind,
      token_hash: tokenHash(token),
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    })
    return token
  }

  async function sendVerificationEmail(user: UserRow): Promise<void> {
    const token = await issueEmailToken(user.id, 'verify_email', 24 * 3600_000)
    try {
      await email.send(verificationEmail(config, user.email, token))
    } catch (err) {
      console.error(`[email] verification send failed for ${user.email}: ${String(err)}`)
      await db.audit(null, 'email.send_failed', { kind: 'verify_email', email: user.email })
    }
  }

  async function sendResetEmail(user: UserRow): Promise<void> {
    const token = await issueEmailToken(user.id, 'reset_password', 3600_000)
    try {
      await email.send(resetEmail(config, user.email, token))
    } catch (err) {
      console.error(`[email] reset send failed for ${user.email}: ${String(err)}`)
      await db.audit(null, 'email.send_failed', { kind: 'reset_password', email: user.email })
    }
  }

  /** warn a tenant: in-app warning + optional email (never throws) */
  async function notifyUser(userId: string, kind: WarningKind, message: string): Promise<void> {
    const result = await warnUser(db, userId, kind, message)
    if (!result.created) return
    const user = await db.getUserById(userId)
    if (!user || !user.email_verified) return
    try {
      await email.send(warningEmail(user.email, message))
    } catch (err) {
      console.error(`[email] warning send failed for ${user.email}: ${String(err)}`)
    }
  }

  /** notify the operator about abuse signals (best effort, never throws) */
  async function alertAdmin(title: string, lines: string[]): Promise<void> {
    await db.audit(null, 'alert', { title, lines })
    if (!config.adminAlertEmail) return
    try {
      await email.send(alertEmail(config.adminAlertEmail, title, lines))
    } catch (err) {
      console.error(`[email] alert send failed: ${String(err)}`)
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

  async function mePayload(identity: Identity) {
    const warnings = identity.legacy ? [] : await db.listWarnings(identity.userId, 20)
    return {
      user: identityPublic(identity),
      quota: await resolveQuotaForOwner(db, identity.userId, config),
      usage: await db.getUsage(identity.userId, today()),
      totals: await quotaUsage(db, identity.userId),
      warnings,
    }
  }

  function ownsTask(identity: Identity, ownerId: string): boolean {
    return identity.role === 'admin' || identity.userId === ownerId
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    // static UI assets: index.html at /, everything else under the public dir
    if (!pathname.startsWith('/api/') && req.method === 'GET' && pathname !== '/metrics') {
      const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1))
      await serveFile(res, publicDir, rel)
      return
    }

    // Prometheus scrape endpoint: loopback always allowed, others need admin
    if (pathname === '/metrics' && req.method === 'GET') {
      const remote = (req.socket.remoteAddress ?? '').replace('::ffff:', '')
      const loopback = remote === '127.0.0.1' || remote === '::1'
      const scrapeIdentity = await authenticate(req, db, config)
      if (!config.metricsOpen && !loopback && scrapeIdentity?.role !== 'admin') {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
      res.end(metrics.render())
      return
    }

    const identity = await authenticate(req, db, config)
    const authOn = await authRequired()
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
      await warnUser(db, identity.userId, 'account_suspended', '账号已被暂停,请联系管理员', { dedupeHours: 72 })
      json(res, 403, { error: 'account suspended' })
      return
    }

    if (identity && !identity.legacy && config.requireEmailVerification && !pathname.startsWith('/api/auth/')) {
      const user = await db.getUserById(identity.userId)
      if (user && !user.email_verified) {
        json(res, 403, { error: 'email not verified', code: 'email_unverified' })
        return
      }
    }

    // ---------- health ----------

    if (pathname === '/api/health') {
      const base = { ok: true }
      if (identity || !authOn) {
        json(res, 200, { ...base, tasks: await store.count(), queue: queue.size, authRequired: authOn })
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

      // cross-instance: poll rows changed since the last tick so updates made
      // by another API/worker instance also reach this stream
      const scope = effective.role === 'admin' ? undefined : effective.userId
      let since = new Date().toISOString()
      const poll = setInterval(async () => {
        try {
          const rows = await db.listTasksUpdatedSince(scope, since, 100)
          for (const row of rows) {
            since = row.updated_at > since ? row.updated_at : since
            const task = await store.get(row.id)
            if (!task) continue
            if (effective.role !== 'admin' && task.ownerId !== effective.userId) continue
            res.write(`event: task\ndata: ${JSON.stringify(task)}\n\n`)
          }
        } catch (err) {
          console.error(`[sse] poll failed: ${String(err)}`)
        }
      }, 2000)
      poll.unref?.()

      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        clearInterval(poll)
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
      if (await db.getUserByEmail(email)) {
        json(res, 409, { error: 'email already registered' })
        return
      }
      const user = await db.createUser({
        id: newId(),
        email,
        name,
        password_hash: hashPassword(password),
        role: 'user',
        status: 'active',
        plan: 'free',
        quota_json: '{}',
        email_verified: config.requireEmailVerification ? 0 : 1,
      })
      if (config.requireEmailVerification) await sendVerificationEmail(user)
      const token = await createSession(db, user.id)
      await db.audit(user.id, 'user.register', { email, verificationSent: config.requireEmailVerification })
      json(
        res,
        201,
        { user: userPublic(user), verificationSent: config.requireEmailVerification },
        { 'set-cookie': sessionCookie(token) },
      )
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
      const user = await db.getUserByEmail(email)
      if (!user || !verifyPassword(password, user.password_hash)) {
        json(res, 401, { error: 'invalid email or password' })
        return
      }
      if (user.status === 'suspended') {
        json(res, 403, { error: 'account suspended' })
        return
      }
      const token = await createSession(db, user.id)
      json(res, 200, { user: userPublic(user) }, { 'set-cookie': sessionCookie(token) })
      return
    }

    if (pathname === '/api/auth/verify-email' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const token = typeof body.token === 'string' ? body.token : ''
      const row = token ? await db.getEmailToken(tokenHash(token)) : undefined
      if (!row || row.kind !== 'verify_email') {
        json(res, 400, { error: 'invalid or expired verification token' })
        return
      }
      await db.useEmailToken(row.id)
      await db.setEmailVerified(row.user_id)
      await db.audit(row.user_id, 'user.email_verified', {})
      json(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/auth/resend-verification' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const emailAddress = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const user = emailAddress ? await db.getUserByEmail(emailAddress) : undefined
      if (user && !user.email_verified) await sendVerificationEmail(user)
      // never reveal whether the account exists
      json(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/auth/forgot-password' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const emailAddress = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      const user = emailAddress ? await db.getUserByEmail(emailAddress) : undefined
      if (user) await sendResetEmail(user)
      json(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/auth/reset-password' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const token = typeof body.token === 'string' ? body.token : ''
      const password = typeof body.password === 'string' ? body.password : ''
      if (password.length < 8) {
        json(res, 400, { error: 'password must be at least 8 characters' })
        return
      }
      const row = token ? await db.getEmailToken(tokenHash(token)) : undefined
      if (!row || row.kind !== 'reset_password') {
        json(res, 400, { error: 'invalid or expired reset token' })
        return
      }
      await db.useEmailToken(row.id)
      await db.updateUser(row.user_id, { password_hash: hashPassword(password) })
      await db.deleteUserSessions(row.user_id) // force re-login everywhere
      await db.audit(row.user_id, 'user.password_reset', {})
      json(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const cookies = req.headers.cookie ?? ''
      const match = cookies.match(/(?:^|;\s*)cp_session=([^;]+)/)
      if (match) await db.deleteSession(tokenHash(match[1]))
      json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie() })
      return
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      json(res, 200, await mePayload(effective))
      return
    }

    // ---------- api tokens ----------

    if (pathname === '/api/tokens' && req.method === 'GET') {
      json(res, 200, { tokens: await db.listApiTokens(effective.userId) })
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
      const created = await createApiToken(db, effective.userId, name)
      await db.audit(effective.userId, 'token.create', { id: created.id })
      json(res, 201, { id: created.id, token: created.token })
      return
    }

    const tokenDelete = pathname.match(/^\/api\/tokens\/([^/]+)$/)
    if (tokenDelete && req.method === 'DELETE') {
      const removed = await db.deleteApiToken(effective.userId, tokenDelete[1])
      await db.audit(effective.userId, 'token.delete', { id: tokenDelete[1] })
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown token' })
      return
    }

    // ---------- warnings ----------

    if (pathname === '/api/warnings' && req.method === 'GET') {
      json(res, 200, { warnings: await db.listWarnings(effective.userId, 50) })
      return
    }

    const warningAck = pathname.match(/^\/api\/warnings\/([^/]+)\/ack$/)
    if (warningAck && req.method === 'POST') {
      const ok = await db.acknowledgeWarning(effective.userId, warningAck[1])
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'unknown warning' })
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
      json(res, 200, { tasks: await store.list(scope), queue: queue.size })
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
      const quota = await checkQuota(db, effective, 'capture', config)
      if (!quota.ok) {
        if (!effective.legacy) void notifyUser(effective.userId, 'quota', quota.message)
        json(res, 403, { error: quota.message, code: quota.code, quota: quota.quota, usage: quota.usage })
        return
      }
      if (!effective.legacy) {
        await maybeQuotaWarning(db, effective.userId, 'capture', quota.usage.tasks, quota.quota.maxTasks, '任务数')
        await maybeQuotaWarning(
          db,
          effective.userId,
          'storage',
          quota.usage.storageBytes,
          quota.quota.maxStorageBytes,
          '存储',
        )
      }
      if (await store.count() >= config.maxTasks) {
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
        if (await db.isDomainBlocked(host)) {
          if (!effective.legacy) {
            void notifyUser(effective.userId, 'blocked_domain', `目标站点已被平台封禁: ${host}`)
          }
          void alertAdmin('封禁域名捕获尝试', [
            `用户: ${effective.email} (${effective.userId})`,
            `目标: ${source}`,
            `时间: ${new Date().toISOString()}`,
          ])
          json(res, 403, { error: `domain blocked by moderation: ${host}` })
          return
        }
      }
      const task = await store.create(effective.userId, { type, source }, sanitizeOptions(input.options))
      if (!effective.legacy) await db.incrUsage(effective.userId, 'capture', today())
      queue.enqueue({ kind: 'capture', taskId: task.id, ownerId: effective.userId })
      json(res, 201, { task })
      return
    }

    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/)
    if (taskMatch && req.method === 'GET') {
      const task = await store.get(taskMatch[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      json(res, 200, { task })
      return
    }

    if (taskMatch && req.method === 'DELETE') {
      const task = await store.get(taskMatch[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      if (task.status === 'running' || task.status === 'queued') {
        json(res, 409, { error: 'task is still running' })
        return
      }
      await store.delete(task.id)
      await db.audit(effective.userId, 'task.delete', { taskId: task.id, owner: task.ownerId })
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
      const task = await store.get(generateMatch[1])
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
      const quota = await checkQuota(db, effective, 'generate', config)
      if (!quota.ok) {
        if (!effective.legacy) void notifyUser(effective.userId, 'quota', quota.message)
        json(res, 403, { error: quota.message, code: quota.code, quota: quota.quota, usage: quota.usage })
        return
      }
      const generation = await store.createGeneration(task.id, {
        reproDir: path.join(store.taskDir(task.id), 'generated-repro'),
        sessionId: `gen-${task.id}-${Date.now().toString(36)}`,
        command: config.agentCommand,
        ...(config.agentModel ? { model: config.agentModel } : {}),
      })
      if (!effective.legacy) await db.incrUsage(effective.userId, 'generate', today())
      queue.enqueue({ kind: 'generate', taskId: task.id, ownerId: task.ownerId, generationId: generation.id })
      json(res, 201, { task: await store.get(task.id), generation })
      return
    }

    const files = pathname.match(/^\/api\/tasks\/([^/]+)\/files\/(.+)$/)
    if (files && req.method === 'GET') {
      const task = await store.get(files[1])
      if (!task || !ownsTask(effective, task.ownerId)) {
        json(res, 404, { error: 'unknown task' })
        return
      }
      await serveFile(res, store.taskDir(files[1]), decodeURIComponent(files[2]))
      return
    }

    const artifacts = pathname.match(/^\/api\/tasks\/([^/]+)\/artifacts\/(.+)$/)
    if (artifacts && req.method === 'GET') {
      const task = await store.get(artifacts[1])
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
    const task = await store.get(taskId)
    if (!task || !ownsTask(identity, task.ownerId)) {
      json(res, 404, { error: 'unknown task' })
      return
    }
    if (task.status !== 'done' || !task.result) {
      json(res, 409, { error: 'capture must finish before verifying' })
      return
    }
    const quota = await checkQuota(db, identity, 'verify', config)
    if (!quota.ok) {
      if (!identity.legacy) void notifyUser(identity.userId, 'quota', quota.message)
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
      if (!identity.legacy) await db.incrUsage(identity.userId, 'verify', today())
      queue.enqueue({ kind: 'verify', taskId, ownerId: task.ownerId, verificationId: verification.id })
      const latest = (await store.get(taskId))!.verifications.find((v) => v.id === verification.id) ?? verification
      json(res, 201, { task: await store.get(taskId), verification: latest })
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
    if (!identity.legacy) await db.incrUsage(identity.userId, 'verify', today())
    queue.enqueue({ kind: 'verify', taskId, ownerId: task.ownerId, verificationId: verification.id })
    json(res, 201, { task: await store.get(taskId), verification })
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
      const users = await Promise.all(
        (await db.listUsers()).map(async (user) => ({
          ...userPublic(user),
          quota: await resolveQuotaForOwner(db, user.id, config),
          totals: await quotaUsage(db, user.id),
        })),
      )
      json(res, 200, { users })
      return
    }

    const userPatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (userPatch && req.method === 'PATCH') {
      const user = await db.getUserById(userPatch[1])
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
      const updated = await db.updateUser(user.id, patch)
      await db.audit(identity.userId, 'admin.user.update', { userId: user.id, patch: { ...patch, password_hash: undefined } })
      json(res, 200, { user: updated ? userPublic(updated) : null })
      return
    }

    if (pathname === '/api/admin/blocks' && req.method === 'GET') {
      json(res, 200, { blocks: await db.listBlocks() })
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
      await db.addBlock(block)
      await db.audit(identity.userId, 'admin.block.add', block)
      json(res, 201, { block })
      return
    }

    const blockDelete = pathname.match(/^\/api\/admin\/blocks\/([^/]+)$/)
    if (blockDelete && req.method === 'DELETE') {
      const removed = await db.removeBlock(blockDelete[1])
      await db.audit(identity.userId, 'admin.block.remove', { id: blockDelete[1] })
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown block' })
      return
    }

    if (pathname === '/api/admin/audit' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 1000)
      json(res, 200, { entries: await db.listAudit(limit) })
      return
    }

    if (pathname === '/api/admin/warnings' && req.method === 'GET') {
      json(res, 200, { warnings: await db.listWarnings(undefined, 200) })
      return
    }

    if (pathname === '/api/admin/warnings' && req.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = (await readBody(req)) as Record<string, unknown>
      } catch {
        json(res, 400, { error: 'invalid JSON body' })
        return
      }
      const userId = typeof body.userId === 'string' ? body.userId : ''
      const message = typeof body.message === 'string' ? body.message.slice(0, 500) : ''
      if (!userId || !message) {
        json(res, 400, { error: 'userId and message required' })
        return
      }
      if (!await db.getUserById(userId)) {
        json(res, 404, { error: 'unknown user' })
        return
      }
      await notifyUser(userId, 'manual', message)
      json(res, 201, { ok: true })
      return
    }

    const adminWarningDelete = pathname.match(/^\/api\/admin\/warnings\/([^/]+)$/)
    if (adminWarningDelete && req.method === 'DELETE') {
      const removed = await db.deleteWarning(adminWarningDelete[1])
      json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'unknown warning' })
      return
    }

    if (pathname === '/api/admin/stats' && req.method === 'GET') {
      const users = await db.listUsers()
      json(res, 200, {
        users: users.length,
        suspended: users.filter((u) => u.status === 'suspended').length,
        tasks: await store.count(),
        storageBytes: await db.sumStorage(),
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
