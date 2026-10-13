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

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  task_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  instance_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_task ON jobs(task_id);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_kind_value ON blocks(kind, value);

CREATE TABLE IF NOT EXISTS warnings (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings(user_id, created_at DESC);

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
  email_verified: number
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

const TASK_UPDATABLE_FIELDS = [
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

export interface JobRow {
  id: string
  kind: 'capture' | 'verify' | 'generate'
  task_id: string
  owner_id: string
  payload_json: string
  status: 'queued' | 'running' | 'done' | 'failed'
  instance_id: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export interface WarningRow {
  id: string
  user_id: string | null
  kind: string
  message: string
  acknowledged: number
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
/**
 * State store contract shared by the SQLite (single-host) and Postgres
 * (multi-host) backends. Consumers depend on this type, not the driver.
 */
export interface Db {
  readonly isPg?: boolean
  createUser(user: Omit<UserRow, 'created_at' | 'updated_at' | 'email_verified'> & { email_verified?: number }): UserRow
  getUserById(id: string): UserRow | undefined
  getUserByEmail(email: string): UserRow | undefined
  listUsers(): UserRow[]
  countUsers(): number
  updateUser(
    id: string,
    patch: Partial<Pick<UserRow, 'name' | 'role' | 'status' | 'plan' | 'quota_json' | 'password_hash' | 'email_verified'>>,
  ): UserRow | undefined
  setEmailVerified(userId: string): void
  createSession(tokenHash: string, userId: string, expiresAt: string): void
  getUserBySessionHash(tokenHash: string): UserRow | undefined
  deleteSession(tokenHash: string): void
  pruneSessions(): number
  createApiToken(row: { id: string; user_id: string; name: string | null; token_hash: string }): void
  getUserByApiTokenHash(tokenHash: string): UserRow | undefined
  listApiTokens(userId: string): { id: string; name: string | null; created_at: string; last_used_at: string | null }[]
  deleteApiToken(userId: string, id: string): boolean
  insertTask(row: TaskRow): void
  updateTask(id: string, patch: Record<string, string | number | null>): void
  getTask(id: string): TaskRow | undefined
  listTasks(ownerId?: string, limit?: number): TaskRow[]
  deleteTask(id: string): boolean
  countTasks(ownerId?: string): number
  sumStorage(ownerId?: string): number
  countActiveTasks(ownerId: string): number
  expiredTaskIds(cutoffIso: string): string[]
  enqueueJob(row: JobRow): void
  claimJob(instanceId: string, excludeOwners?: string[]): JobRow | undefined
  finishJob(id: string, status: 'done' | 'failed', error?: string): void
  requeueStaleJobs(timeoutMs: number): number
  countJobs(status?: JobRow['status'], ownerId?: string): number
  listJobs(limit?: number): JobRow[]
  deleteJobsForTask(taskId: string): void
  listTasksUpdatedSince(ownerId: string | undefined, sinceIso: string, limit?: number): TaskRow[]
  incrUsage(userId: string, kind: string, day: string, by?: number): void
  getUsage(userId: string, day: string): Record<string, number>
  createEmailToken(row: { id: string; user_id: string; kind: string; token_hash: string; expires_at: string }): void
  getEmailToken(tokenHash: string): { id: string; user_id: string; kind: string } | undefined
  useEmailToken(id: string): void
  deleteEmailTokens(userId: string, kind: string): void
  pruneEmailTokens(): void
  deleteUserSessions(userId: string): void
  createWarning(row: WarningRow): void
  recentWarning(userId: string | null, kind: string, hours: number): WarningRow | undefined
  listWarnings(userId?: string, limit?: number): WarningRow[]
  acknowledgeWarning(userId: string, id: string): boolean
  deleteWarning(id: string): boolean
  addBlock(row: BlockRow): void
  removeBlock(id: string): boolean
  listBlocks(): BlockRow[]
  isDomainBlocked(host: string): boolean
  audit(actorId: string | null, action: string, detail?: unknown): void
  listAudit(limit?: number): AuditRow[]
}

export class SqliteDb implements Db {
  readonly db: DatabaseSync

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new DatabaseSync(path.join(dataDir, 'copypage.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** additive migrations for databases created before a column existed */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(users)').all() as { name: string }[]
    if (!columns.some((c) => c.name === 'email_verified')) {
      this.db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0')
      // accounts created before verification existed stay usable
      this.db.exec('UPDATE users SET email_verified = 1')
    }
  }

  close(): void {
    this.db.close()
  }

  // ---------- users ----------

  createUser(user: Omit<UserRow, 'created_at' | 'updated_at' | 'email_verified'> & { email_verified?: number }): UserRow {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, role, status, plan, quota_json, email_verified, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        user.email_verified ?? 0,
        now,
        now,
      )
    return this.getUserById(user.id)!
  }

  setEmailVerified(userId: string): void {
    this.db
      .prepare('UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), userId)
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
    patch: Partial<
      Pick<UserRow, 'name' | 'role' | 'status' | 'plan' | 'quota_json' | 'password_hash' | 'email_verified'>
    >,
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

  updateTask(id: string, patch: Partial<Record<(typeof TASK_UPDATABLE_FIELDS)[number], string | number | null>>): void {
    const fields = Object.keys(patch)
    if (fields.length === 0) return
    for (const key of fields) {
      if (!(TASK_UPDATABLE_FIELDS as readonly string[]).includes(key)) throw new Error(`task field not updatable: ${key}`)
    }
    const sets = fields.map((f) => `${f} = ?`).join(', ')
    const values = fields.map((f) => patch[f as (typeof TASK_UPDATABLE_FIELDS)[number]] as string | number | null)
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

  // ---------- job queue (multi-instance safe) ----------

  enqueueJob(row: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, task_id, owner_id, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(row.id, row.kind, row.task_id, row.owner_id, row.payload_json, row.created_at)
  }

  /**
   * Atomically claim the oldest queued job this instance can run. Excluded
   * owners are those already at their per-tenant concurrency limit.
   */
  claimJob(instanceId: string, excludeOwners: string[] = []): JobRow | undefined {
    const now = new Date().toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const placeholders = excludeOwners.map(() => '?').join(',')
      const sql = `SELECT * FROM jobs WHERE status = 'queued'
        ${excludeOwners.length ? `AND owner_id NOT IN (${placeholders})` : ''}
        ORDER BY created_at LIMIT 1`
      const row = this.db.prepare(sql).get(...excludeOwners) as JobRow | undefined
      if (!row) {
        this.db.exec('COMMIT')
        return undefined
      }
      const res = this.db
        .prepare("UPDATE jobs SET status = 'running', instance_id = ?, started_at = ? WHERE id = ? AND status = 'queued'")
        .run(instanceId, now, row.id)
      this.db.exec('COMMIT')
      if (Number(res.changes) !== 1) return undefined
      return { ...row, status: 'running', instance_id: instanceId, started_at: now }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  finishJob(id: string, status: 'done' | 'failed', error?: string): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?')
      .run(status, error ?? null, new Date().toISOString(), id)
  }

  /** jobs whose instance died mid-run: put them back on the queue */
  requeueStaleJobs(timeoutMs: number): number {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString()
    const res = this.db
      .prepare(
        "UPDATE jobs SET status = 'queued', instance_id = NULL, started_at = NULL WHERE status = 'running' AND started_at < ?",
      )
      .run(cutoff)
    return Number(res.changes)
  }

  countJobs(status?: JobRow['status'], ownerId?: string): number {
    const clauses: string[] = []
    const values: string[] = []
    if (status) {
      clauses.push('status = ?')
      values.push(status)
    }
    if (ownerId) {
      clauses.push('owner_id = ?')
      values.push(ownerId)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).get(...values) as { n: number }
    return row.n
  }

  listJobs(limit = 100): JobRow[] {
    return this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as JobRow[]
  }

  deleteJobsForTask(taskId: string): void {
    this.db.prepare('DELETE FROM jobs WHERE task_id = ?').run(taskId)
  }

  /** tasks changed since a timestamp — drives SSE polling across instances */
  listTasksUpdatedSince(ownerId: string | undefined, sinceIso: string, limit = 100): TaskRow[] {
    if (ownerId) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE owner_id = ? AND updated_at > ? ORDER BY updated_at LIMIT ?')
        .all(ownerId, sinceIso, limit) as unknown as TaskRow[]
    }
    return this.db
      .prepare('SELECT * FROM tasks WHERE updated_at > ? ORDER BY updated_at LIMIT ?')
      .all(sinceIso, limit) as unknown as TaskRow[]
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

  // ---------- email tokens ----------

  createEmailToken(row: { id: string; user_id: string; kind: string; token_hash: string; expires_at: string }): void {
    this.db
      .prepare(
        'INSERT INTO email_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.user_id, row.kind, row.token_hash, row.expires_at, new Date().toISOString())
  }

  /** valid = matching hash, unused, not expired */
  getEmailToken(tokenHash: string): { id: string; user_id: string; kind: string } | undefined {
    return this.db
      .prepare(
        `SELECT id, user_id, kind FROM email_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, new Date().toISOString()) as { id: string; user_id: string; kind: string } | undefined
  }

  useEmailToken(id: string): void {
    this.db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ?').run(new Date().toISOString(), id)
  }

  deleteEmailTokens(userId: string, kind: string): void {
    this.db.prepare('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?').run(userId, kind)
  }

  pruneEmailTokens(): void {
    this.db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?').run(new Date().toISOString())
  }

  deleteUserSessions(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
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

  // ---------- warnings (abuse / quota signals) ----------

  createWarning(row: WarningRow): void {
    this.db
      .prepare('INSERT INTO warnings (id, user_id, kind, message, acknowledged, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.user_id, row.kind, row.message, row.acknowledged, row.created_at)
  }

  /** dedupe window: same user+kind within `hours` */
  recentWarning(userId: string | null, kind: string, hours: number): WarningRow | undefined {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString()
    return this.db
      .prepare('SELECT * FROM warnings WHERE user_id IS ? AND kind = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1')
      .get(userId, kind, cutoff)  as unknown as WarningRow | undefined
  }

  listWarnings(userId?: string, limit = 100): WarningRow[] {
    if (userId) {
      return this.db
        .prepare('SELECT * FROM warnings WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(userId, limit) as unknown as WarningRow[]
    }
    return this.db
      .prepare('SELECT * FROM warnings ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as WarningRow[]
  }

  acknowledgeWarning(userId: string, id: string): boolean {
    const res = this.db
      .prepare('UPDATE warnings SET acknowledged = 1 WHERE id = ? AND user_id = ?')
      .run(id, userId)
    return Number(res.changes) > 0
  }

  deleteWarning(id: string): boolean {
    const res = this.db.prepare('DELETE FROM warnings WHERE id = ?').run(id)
    return Number(res.changes) > 0
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
