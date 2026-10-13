import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { ServerConfig } from './config.js'
import type { Db, UserRow } from './db.js'

export interface Identity {
  userId: string
  email: string
  name: string | null
  role: 'user' | 'admin'
  status: 'active' | 'suspended'
  plan: string
  /** authenticated with the legacy single COPYPAGE_TOKEN (single-tenant mode) */
  legacy?: boolean
}

export const SESSION_COOKIE = 'cp_session'
const SESSION_TTL_MS = 30 * 24 * 3600_000

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function newId(): string {
  return randomUUID()
}

/** Create a login session; returns the plaintext token for the cookie. */
export function createSession(db: Db, userId: string, ttlMs = SESSION_TTL_MS): string {
  const token = newToken()
  db.createSession(tokenHash(token), userId, new Date(Date.now() + ttlMs).toISOString())
  return token
}

export function createApiToken(db: Db, userId: string, name: string | null): { id: string; token: string } {
  const id = randomUUID()
  const token = `cp_${newToken()}`
  db.createApiToken({ id, user_id: userId, name, token_hash: tokenHash(token) })
  return { id, token }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(value)
  }
  return out
}

export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function toIdentity(user: UserRow, legacy = false): Identity {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    plan: user.plan,
    ...(legacy ? { legacy: true } : {}),
  }
}

/**
 * Resolve the caller: session cookie → API token → legacy shared token.
 * Returns null when nothing matches (caller decides 401 vs open mode).
 */
export function authenticate(req: IncomingMessage, db: Db, config: ServerConfig): Identity | null {
  const cookies = parseCookies(req.headers.cookie)
  const sessionToken = cookies[SESSION_COOKIE]
  if (sessionToken) {
    const user = db.getUserBySessionHash(tokenHash(sessionToken))
    if (user) return toIdentity(user)
  }

  const header = req.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined
  const apiKey = (req.headers['x-api-key'] as string | undefined)?.trim()
  // EventSource cannot set headers; allow ?token= as well (never logged)
  let queryToken: string | undefined
  try {
    queryToken = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')?.trim() ?? undefined
  } catch {
    queryToken = undefined
  }
  const provided = bearer ?? apiKey ?? queryToken
  if (provided) {
    const user = db.getUserByApiTokenHash(tokenHash(provided))
    if (user) return toIdentity(user)
    if (config.token && provided === config.token) {
      // legacy single-tenant token: acts as the system administrator
      return {
        userId: 'system',
        email: 'system',
        name: 'system',
        role: 'admin',
        status: 'active',
        plan: 'unlimited',
        legacy: true,
      }
    }
  }
  return null
}

/** True when the server has any real auth configured (multi-tenant mode). */
export function authRequired(db: Db, config: ServerConfig): boolean {
  return Boolean(config.token) || Boolean(config.adminEmail) || db.countUsers() > 0
}

/** Create the bootstrap admin from config if it does not exist yet. */
export function ensureBootstrapAdmin(db: Db, config: ServerConfig): UserRow | undefined {
  if (!config.adminEmail || !config.adminPassword) return undefined
  const email = config.adminEmail.toLowerCase()
  const existing = db.getUserByEmail(email)
  if (existing) {
    if (existing.role !== 'admin') db.updateUser(existing.id, { role: 'admin' })
    return db.getUserByEmail(email)
  }
  const user = db.createUser({
    id: randomUUID(),
    email,
    name: 'admin',
    password_hash: hashPassword(config.adminPassword),
    role: 'admin',
    status: 'active',
    plan: 'unlimited',
    quota_json: '{}',
    email_verified: 1,
  })
  db.audit(null, 'admin.bootstrap', { email })
  return user
}
