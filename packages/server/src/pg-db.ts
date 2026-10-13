import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import type { Db } from './db.js'
import type {
  AuditRow,
  BlockRow,
  JobRow,
  TaskRow,
  UserRow,
  WarningRow,
} from './db.js'

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
  email_verified INTEGER NOT NULL DEFAULT 0,
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
  size_bytes BIGINT NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS warnings (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_kind_value ON blocks(kind, value);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  at TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
`

const TASK_UPDATABLE = [
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

/**
 * Postgres-backed state store for multi-host deployments. Implements the same
 * async contract as SqliteDb; jobs are claimed with FOR UPDATE SKIP LOCKED so
 * any number of API/worker instances can share one queue.
 */
/** minimal surface shared by pg.Pool and PGlite-style embedded backends */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>
  /** multi-statement execution (schema setup); falls back to query() */
  exec?(text: string): Promise<void>
  end(): Promise<void>
}

export class PgDb implements Db {
  readonly isPg = true

  private constructor(private client: PgQueryable) {}

  /** connect to a real Postgres server and create the schema */
  static async create(connectionString: string): Promise<PgDb> {
    const pool = new Pool({ connectionString, max: 10 })
    const db = new PgDb(pool as unknown as PgQueryable)
    await db.client.query(SCHEMA)
    return db
  }

  /** build a store on any PgQueryable (embedded Postgres in tests) */
  static async fromQueryable(client: PgQueryable): Promise<PgDb> {
    const db = new PgDb(client)
    if (client.exec) await client.exec(SCHEMA)
    else await client.query(SCHEMA)
    return db
  }

  private async query<T>(text: string, values: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(text, values)
    return res.rows as T[]
  }

  async close(): Promise<void> {
    await this.client.end()
  }

  // ---------- users ----------

  async createUser(
    user: Omit<UserRow, 'created_at' | 'updated_at' | 'email_verified'> & { email_verified?: number },
  ): Promise<UserRow> {
    const now = new Date().toISOString()
    await this.query(
      `INSERT INTO users (id, email, name, password_hash, role, status, plan, quota_json, email_verified, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
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
      ],
    )
    const created = await this.getUserById(user.id)
    if (!created) throw new Error('user creation failed')
    return created
  }

  async getUserById(id: string): Promise<UserRow | undefined> {
    return (await this.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]))[0]
  }

  async getUserByEmail(email: string): Promise<UserRow | undefined> {
    return (await this.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]))[0]
  }

  async listUsers(): Promise<UserRow[]> {
    return this.query<UserRow>('SELECT * FROM users ORDER BY created_at DESC')
  }

  async countUsers(): Promise<number> {
    const rows = await this.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM users')
    return Number(rows[0]?.n ?? 0)
  }

  async updateUser(
    id: string,
    patch: Partial<
      Pick<UserRow, 'name' | 'role' | 'status' | 'plan' | 'quota_json' | 'password_hash' | 'email_verified'>
    >,
  ): Promise<UserRow | undefined> {
    const fields = Object.keys(patch)
    if (fields.length === 0) return this.getUserById(id)
    const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ')
    const values = fields.map((f) => (patch as Record<string, unknown>)[f] as string | number)
    await this.query(`UPDATE users SET ${sets}, updated_at = $${fields.length + 1} WHERE id = $${fields.length + 2}`, [
      ...values,
      new Date().toISOString(),
      id,
    ])
    return this.getUserById(id)
  }

  async setEmailVerified(userId: string): Promise<void> {
    await this.query('UPDATE users SET email_verified = 1, updated_at = $1 WHERE id = $2', [
      new Date().toISOString(),
      userId,
    ])
  }

  // ---------- sessions ----------

  async createSession(tokenHash: string, userId: string, expiresAt: string): Promise<void> {
    await this.query(
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1,$2,$3,$4)',
      [tokenHash, userId, new Date().toISOString(), expiresAt],
    )
  }

  async getUserBySessionHash(tokenHash: string): Promise<UserRow | undefined> {
    return (
      await this.query<UserRow>(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > $2`,
        [tokenHash, new Date().toISOString()],
      )
    )[0]
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
  }

  async pruneSessions(): Promise<number> {
    const res = await this.client.query('DELETE FROM sessions WHERE expires_at <= $1', [new Date().toISOString()])
    return res.rowCount ?? 0
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  }

  // ---------- api tokens ----------

  async createApiToken(row: { id: string; user_id: string; name: string | null; token_hash: string }): Promise<void> {
    await this.query(
      'INSERT INTO api_tokens (id, user_id, name, token_hash, created_at) VALUES ($1,$2,$3,$4,$5)',
      [row.id, row.user_id, row.name, row.token_hash, new Date().toISOString()],
    )
  }

  async getUserByApiTokenHash(tokenHash: string): Promise<UserRow | undefined> {
    const rows = await this.query<UserRow>(
      `SELECT u.* FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1`,
      [tokenHash],
    )
    if (rows[0]) {
      await this.query('UPDATE api_tokens SET last_used_at = $1 WHERE token_hash = $2', [
        new Date().toISOString(),
        tokenHash,
      ])
    }
    return rows[0]
  }

  async listApiTokens(
    userId: string,
  ): Promise<{ id: string; name: string | null; created_at: string; last_used_at: string | null }[]> {
    return this.query(
      'SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [userId],
    )
  }

  async deleteApiToken(userId: string, id: string): Promise<boolean> {
    const res = await this.client.query('DELETE FROM api_tokens WHERE user_id = $1 AND id = $2', [userId, id])
    return (res.rowCount ?? 0) > 0
  }

  // ---------- tasks ----------

  async insertTask(row: TaskRow): Promise<void> {
    await this.query(
      `INSERT INTO tasks (id, owner_id, status, input_json, options_json, progress_json, loop_json,
         verifications_json, generations_json, result_json, worker_json, size_bytes, error, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
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
      ],
    )
  }

  async updateTask(id: string, patch: Partial<Record<(typeof TASK_UPDATABLE)[number], string | number | null>>): Promise<void> {
    const fields = Object.keys(patch)
    if (fields.length === 0) return
    for (const key of fields) {
      if (!(TASK_UPDATABLE as readonly string[]).includes(key)) throw new Error(`task field not updatable: ${key}`)
    }
    const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ')
    const values = fields.map((f) => patch[f as (typeof TASK_UPDATABLE)[number]] as string | number | null)
    await this.query(`UPDATE tasks SET ${sets} WHERE id = $${fields.length + 1}`, [...values, id])
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    return (await this.query<TaskRow>('SELECT * FROM tasks WHERE id = $1', [id]))[0]
  }

  async listTasks(ownerId?: string, limit = 500): Promise<TaskRow[]> {
    if (ownerId) {
      return this.query<TaskRow>(
        'SELECT * FROM tasks WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2',
        [ownerId, limit],
      )
    }
    return this.query<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1', [limit])
  }

  async deleteTask(id: string): Promise<boolean> {
    const res = await this.client.query('DELETE FROM tasks WHERE id = $1', [id])
    return (res.rowCount ?? 0) > 0
  }

  async countTasks(ownerId?: string): Promise<number> {
    const rows = ownerId
      ? await this.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM tasks WHERE owner_id = $1', [ownerId])
      : await this.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM tasks')
    return Number(rows[0]?.n ?? 0)
  }

  async sumStorage(ownerId?: string): Promise<number> {
    const rows = ownerId
      ? await this.query<{ n: string }>(
          'SELECT COALESCE(SUM(size_bytes),0)::text AS n FROM tasks WHERE owner_id = $1',
          [ownerId],
        )
      : await this.query<{ n: string }>('SELECT COALESCE(SUM(size_bytes),0)::text AS n FROM tasks')
    return Number(rows[0]?.n ?? 0)
  }

  async countActiveTasks(ownerId: string): Promise<number> {
    const rows = await this.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM tasks WHERE owner_id = $1 AND status IN ('queued','running')",
      [ownerId],
    )
    return Number(rows[0]?.n ?? 0)
  }

  async expiredTaskIds(cutoffIso: string): Promise<string[]> {
    const rows = await this.query<{ id: string }>(
      "SELECT id FROM tasks WHERE status NOT IN ('queued','running') AND updated_at < $1",
      [cutoffIso],
    )
    return rows.map((r) => r.id)
  }

  async listTasksUpdatedSince(ownerId: string | undefined, sinceIso: string, limit = 100): Promise<TaskRow[]> {
    if (ownerId) {
      return this.query<TaskRow>(
        'SELECT * FROM tasks WHERE owner_id = $1 AND updated_at > $2 ORDER BY updated_at LIMIT $3',
        [ownerId, sinceIso, limit],
      )
    }
    return this.query<TaskRow>('SELECT * FROM tasks WHERE updated_at > $1 ORDER BY updated_at LIMIT $2', [
      sinceIso,
      limit,
    ])
  }

  // ---------- jobs ----------

  async enqueueJob(row: JobRow): Promise<void> {
    await this.query(
      `INSERT INTO jobs (id, kind, task_id, owner_id, payload_json, status, created_at)
       VALUES ($1,$2,$3,$4,$5,'queued',$6)`,
      [row.id, row.kind, row.task_id, row.owner_id, row.payload_json, row.created_at],
    )
  }

  /** atomic claim: SKIP LOCKED lets every instance work the same queue safely */
  async claimJob(instanceId: string, excludeOwners: string[] = []): Promise<JobRow | undefined> {
    const rows = await this.query<JobRow>(
      `UPDATE jobs SET status = 'running', instance_id = $1, started_at = $2
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND NOT (owner_id = ANY($3::text[]))
         ORDER BY created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [instanceId, new Date().toISOString(), excludeOwners],
    )
    return rows[0]
  }

  async finishJob(id: string, status: 'done' | 'failed', error?: string): Promise<void> {
    await this.query('UPDATE jobs SET status = $1, error = $2, finished_at = $3 WHERE id = $4', [
      status,
      error ?? null,
      new Date().toISOString(),
      id,
    ])
  }

  async requeueStaleJobs(timeoutMs: number): Promise<number> {
    const res = await this.client.query(
      "UPDATE jobs SET status = 'queued', instance_id = NULL, started_at = NULL WHERE status = 'running' AND started_at < $1",
      [new Date(Date.now() - timeoutMs).toISOString()],
    )
    return res.rowCount ?? 0
  }

  async countJobs(status?: JobRow['status'], ownerId?: string): Promise<number> {
    const clauses: string[] = []
    const values: string[] = []
    if (status) {
      values.push(status)
      clauses.push(`status = $${values.length}`)
    }
    if (ownerId) {
      values.push(ownerId)
      clauses.push(`owner_id = $${values.length}`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = await this.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM jobs ${where}`, values)
    return Number(rows[0]?.n ?? 0)
  }

  async listJobs(limit = 100): Promise<JobRow[]> {
    return this.query<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1', [limit])
  }

  async deleteJobsForTask(taskId: string): Promise<void> {
    await this.query('DELETE FROM jobs WHERE task_id = $1', [taskId])
  }

  // ---------- usage ----------

  async incrUsage(userId: string, kind: string, day: string, by = 1): Promise<void> {
    await this.query(
      `INSERT INTO usage_counters (user_id, day, kind, count) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, day, kind) DO UPDATE SET count = usage_counters.count + $4`,
      [userId, day, kind, by],
    )
  }

  async getUsage(userId: string, day: string): Promise<Record<string, number>> {
    const rows = await this.query<{ kind: string; count: number }>(
      'SELECT kind, count FROM usage_counters WHERE user_id = $1 AND day = $2',
      [userId, day],
    )
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)]))
  }

  // ---------- email tokens ----------

  async createEmailToken(row: {
    id: string
    user_id: string
    kind: string
    token_hash: string
    expires_at: string
  }): Promise<void> {
    await this.query(
      'INSERT INTO email_tokens (id, user_id, kind, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [row.id, row.user_id, row.kind, row.token_hash, row.expires_at, new Date().toISOString()],
    )
  }

  async getEmailToken(tokenHash: string): Promise<{ id: string; user_id: string; kind: string } | undefined> {
    return (
      await this.query<{ id: string; user_id: string; kind: string }>(
        `SELECT id, user_id, kind FROM email_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
        [tokenHash, new Date().toISOString()],
      )
    )[0]
  }

  async useEmailToken(id: string): Promise<void> {
    await this.query('UPDATE email_tokens SET used_at = $1 WHERE id = $2', [new Date().toISOString(), id])
  }

  async deleteEmailTokens(userId: string, kind: string): Promise<void> {
    await this.query('DELETE FROM email_tokens WHERE user_id = $1 AND kind = $2', [userId, kind])
  }

  async pruneEmailTokens(): Promise<void> {
    await this.query('DELETE FROM email_tokens WHERE expires_at <= $1', [new Date().toISOString()])
  }

  // ---------- warnings ----------

  async createWarning(row: WarningRow): Promise<void> {
    await this.query(
      'INSERT INTO warnings (id, user_id, kind, message, acknowledged, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [row.id, row.user_id, row.kind, row.message, row.acknowledged, row.created_at],
    )
  }

  async recentWarning(userId: string | null, kind: string, hours: number): Promise<WarningRow | undefined> {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString()
    return (
      await this.query<WarningRow>(
        `SELECT * FROM warnings WHERE user_id IS NOT DISTINCT FROM $1 AND kind = $2 AND created_at > $3
         ORDER BY created_at DESC LIMIT 1`,
        [userId, kind, cutoff],
      )
    )[0]
  }

  async listWarnings(userId?: string, limit = 100): Promise<WarningRow[]> {
    if (userId) {
      return this.query<WarningRow>(
        'SELECT * FROM warnings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
        [userId, limit],
      )
    }
    return this.query<WarningRow>('SELECT * FROM warnings ORDER BY created_at DESC LIMIT $1', [limit])
  }

  async acknowledgeWarning(userId: string, id: string): Promise<boolean> {
    const res = await this.client.query('UPDATE warnings SET acknowledged = 1 WHERE id = $1 AND user_id = $2', [
      id,
      userId,
    ])
    return (res.rowCount ?? 0) > 0
  }

  async deleteWarning(id: string): Promise<boolean> {
    const res = await this.client.query('DELETE FROM warnings WHERE id = $1', [id])
    return (res.rowCount ?? 0) > 0
  }

  // ---------- blocks ----------

  async addBlock(row: BlockRow): Promise<void> {
    await this.query(
      `INSERT INTO blocks (id, kind, value, note, created_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (kind, value) DO UPDATE SET note = $4`,
      [row.id, row.kind, row.value.toLowerCase(), row.note, row.created_at],
    )
  }

  async removeBlock(id: string): Promise<boolean> {
    const res = await this.client.query('DELETE FROM blocks WHERE id = $1', [id])
    return (res.rowCount ?? 0) > 0
  }

  async listBlocks(): Promise<BlockRow[]> {
    return this.query<BlockRow>('SELECT * FROM blocks ORDER BY created_at DESC')
  }

  async isDomainBlocked(host: string): Promise<boolean> {
    const h = host.toLowerCase()
    const rows = await this.query<{ value: string }>(
      "SELECT value FROM blocks WHERE kind = 'domain' AND ($1 = value OR $1 LIKE '%.' || value OR value = '*')",
      [h],
    )
    return rows.length > 0
  }

  // ---------- audit ----------

  async audit(actorId: string | null, action: string, detail?: unknown): Promise<void> {
    await this.query('INSERT INTO audit_log (at, actor_id, action, detail) VALUES ($1,$2,$3,$4)', [
      new Date().toISOString(),
      actorId,
      action,
      detail === undefined ? null : JSON.stringify(detail),
    ])
  }

  async listAudit(limit = 200): Promise<AuditRow[]> {
    return this.query<AuditRow>('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit])
  }

  /** helper for tests: run a statement directly */
  async exec(sql: string): Promise<void> {
    await this.query(sql)
  }
}
