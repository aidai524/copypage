import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  plan TEXT NOT NULL DEFAULT 'free',
  quota_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '[]',
  loop_json TEXT NOT NULL DEFAULT '{}',
  verifications_json TEXT NOT NULL DEFAULT '[]',
  generations_json TEXT NOT NULL DEFAULT '[]',
  result_json TEXT,
  worker_json TEXT NOT NULL DEFAULT '{}',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_kind_value ON blocks(kind, value);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`

export interface UserRow {
  id: string
  email: string
  name: string | null
  password_hash: string
  role: 'user' | 'admin'
  status: 'active' | 'suspended'
  plan: string
  quota_json: string
  created_at: string
  updated_at: string
}

export interface TaskRow {
  id: string
  owner_id: string
  status: string
  input_json: string
  options_json: string
  progress_json: string
  loop_json: string
  verifications_json: string
  generations_json: string
  result_json: string | null
  worker_json: string
  size_bytes: number
  error: string | null
  created_at: string
  updated_at: string
}

export interface BlockRow {
  id: string
  kind: 'domain' | 'user'
  value: string
  note: string | null
  created_at: string
}

export interface AuditRow {
  id: number
  at: string
  actor_id: string | null
  action: string
  detail: string | null
}

/**
 * SQLite-backed multi-tenant state. The database is the source of truth for
 * users, sessions, tasks and usage; artifacts stay on disk under dataDir.
 */
export class Db {
  readonly db: DatabaseSync

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(dataDir, 'copypage.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  // ---------- users ----------

  createUser(user: Omit<UserRow, 'created_at' | 'updated_at'>): UserRow {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, role, status, plan, quota_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        user.id,
        user.email.toLowerCase(),
        user.name,
        user.password_hash,
        user.role,
        user.status,
        user.plan,
        user.quota_json,
        now,
        now,
      )
    return this.getUserById(user.id)!
  }

  getUserById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined
  }

  getUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) as
      | UserRow
      | undefined
  }

  listUsers(): UserRow[] {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as unknown as UserRow[]
  }

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    return row.n
  }

  updateUser(
    id: string,
    patch: Partial<Pick<UserRow, 'name' | 'role' | 'status' | 'plan' | 'quota_json' | 'password_hash'>>,
  ): UserRow | undefined {
    const fields = Object.keys(patch)
    if (fields.length === 0) return this.getUserById(id)
    const sets = fields.map((f) => `${f} = ?`).join(', ')
    const values = fields.map((f) => (patch as Record<string, unknown>)[f] as string)
    this.db
      .prepare(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...values, new Date().toISOString(), id)
    return this.getUserById(id)
  }

  // ---------- sessions ----------

  createSession(tokenHash: string, userId: string, expiresAt: string): void {
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(tokenHash, userId, new Date().toISOString(), expiresAt)
  }

  getUserBySessionHash(tokenHash: string): UserRow | undefined {
    const row = this.db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, new Date().toISOString()) as unknown as UserRow | undefined
    return row
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
  }

  pruneSessions(): number {
    const res = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString())
    return Number(res.changes)
  }

  // ---------- api tokens ----------

  createApiToken(row: { id: string; user_id: string; name: string | null; token_hash: string }): void {
    this.db
      .prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.name, row.token_hash, new Date().toISOString())
  }

  getUserByApiTokenHash(tokenHash: string): UserRow | undefined {
    const row = this.db
      .prepare(
        `SELECT u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`,
      )
      .get(tokenHash) as unknown as UserRow | undefined
    if (row) {
      this.db
        .prepare('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?')
        .run(new Date().toISOString(), tokenHash)
    }
    return row
  }

  listApiTokens(userId: string): { id: string; name: string | null; created_at: string; last_used_at: string | null }[] {
    return this.db
      .prepare('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId) as { id: string; name: string | null; created_at: string; last_used_at: string | null }[]
  }

  deleteApiToken(userId: string, id: string): boolean {
    const res = this.db.prepare('DELETE FROM api_tokens WHERE user_id = ? AND id = ?').run(userId, id)
    return Number(res.changes) > 0
  }

  // ---------- tasks ----------

  insertTask(row: TaskRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, owner_id, status, input_json, options_json, progress_json, loop_json,
           verifications_json, generations_json, result_json, worker_json, size_bytes, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.owner_id,
        row.status,
        row.input_json,
        row.options_json,
        row.progress_json,
        row.loop_json,
        row.verifications_json,
        row.generations_json,
        row.result_json,
        row.worker_json,
        row.size_bytes,
        row.error,
        row.created_at,
        row.updated_at,
      )
  }

  private static UPDATABLE = [
    'status',
    'progress_json',
    'loop_json',
    'verifications_json',
    'generations_json',
    'result_json',
    'worker_json',
    'size_bytes',
    'error',
    'updated_at',
  ] as const

  updateTask(id: string, patch: Partial<Record<(typeof Db.UPDATABLE)[number], string | number | null>>): void {
    const fields = Object.keys(patch)
    if (fields.length === 0) return
    for (const key of fields) {
      if (!(Db.UPDATABLE as readonly string[]).includes(key)) throw new Error(`task field not updatable: ${key}`)
    }
    const sets = fields.map((f) => `${f} = ?`).join(', ')
    const values = fields.map((f) => patch[f as (typeof Db.UPDATABLE)[number]] as string | number | null)
    this.db.prepare(`UPDATE tasks SET ${sets} WHERE id = ?`).run(...values, id)
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow | undefined
  }

  listTasks(ownerId?: string, limit = 500): TaskRow[] {
    if (ownerId) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(ownerId, limit) as unknown as TaskRow[]
    }
    return this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as TaskRow[]
  }

  deleteTask(id: string): boolean {
    const res = this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  countTasks(ownerId?: string): number {
    const row = ownerId
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?').get(ownerId) as { n: number })
      : (this.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number })
    return row.n
  }

  sumStorage(ownerId?: string): number {
    const row = ownerId
      ? (this.db
          .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM tasks WHERE owner_id = ?')
          .get(ownerId) as { n: number })
      : (this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM tasks').get() as { n: number })
    return Number(row.n)
  }

  countActiveTasks(ownerId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND status IN ('queued','running')")
      .get(ownerId) as { n: number }
    return row.n
  }

  /** ids of finished tasks older than the cutoff (retention sweep) */
  expiredTaskIds(cutoffIso: string): string[] {
    return (
      this.db
        .prepare("SELECT id FROM tasks WHERE status NOT IN ('queued','running') AND updated_at < ?")
        .all(cutoffIso) as { id: string }[]
    ).map((r) => r.id)
  }

  // ---------- usage ----------

  incrUsage(userId: string, kind: string, day: string, by = 1): void {
    this.db
      .prepare(
        `INSERT INTO usage_counters (user_id, day, kind, count) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, day, kind) DO UPDATE SET count = count + ?`,
      )
      .run(userId, day, kind, by, by)
  }

  getUsage(userId: string, day: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT kind, count FROM usage_counters WHERE user_id = ? AND day = ?')
      .all(userId, day) as { kind: string; count: number }[]
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]))
  }

  // ---------- blocks ----------

  addBlock(row: BlockRow): void {
    this.db
      .prepare('INSERT OR REPLACE INTO blocks (id, kind, value, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.kind, row.value.toLowerCase(), row.note, row.created_at)
  }

  removeBlock(id: string): boolean {
    const res = this.db.prepare('DELETE FROM blocks WHERE id = ?').run(id)
    return Number(res.changes) > 0
  }

  listBlocks(): BlockRow[] {
    return this.db.prepare('SELECT * FROM blocks ORDER BY created_at DESC').all() as unknown as BlockRow[]
  }

  /** blocked when the entry equals the host or is one of its parent domains */
  isDomainBlocked(host: string): boolean {
    const h = host.toLowerCase()
    const rows = this.db.prepare("SELECT value FROM blocks WHERE kind = 'domain'").all() as { value: string }[]
    return rows.some((r) => h === r.value || h.endsWith(`.${r.value}`) || r.value === '*')
  }

  // ---------- audit ----------

  audit(actorId: string | null, action: string, detail?: unknown): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor_id, action, detail) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), actorId, action, detail === undefined ? null : JSON.stringify(detail))
  }

  listAudit(limit = 200): AuditRow[] {
    return this.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as AuditRow[]
  }
}
