import { PGlite } from '@electric-sql/pglite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic } from '@copypage/core'
import { startServer } from '../src/index.js'
import { PgDb, type PgQueryable } from '../src/pg-db.js'
import type { Task } from '../src/types.js'

/**
 * Postgres backend tests. By default they run against an embedded PGlite
 * (real Postgres SQL, single connection). Point them at a server to also test
 * cross-connection job claiming:
 *
 *   COPYPAGE_TEST_DATABASE_URL=postgres://user:pass@host:5432/copypage_test npm test
 */
const URL = process.env.COPYPAGE_TEST_DATABASE_URL

async function makeDb(): Promise<PgDb> {
  if (URL) return PgDb.create(URL)
  const pg = new PGlite()
  const client: PgQueryable = {
    query: async (text, values) => {
      const res = await pg.query(text, values as unknown[] | undefined)
      return { rows: res.rows as unknown[], rowCount: res.affectedRows ?? null }
    },
    exec: async (text) => {
      await pg.exec(text)
    },
    end: () => pg.close(),
  }
  return PgDb.fromQueryable(client)
}

describe(`PgDb (${URL ? 'server' : 'embedded PGlite'})`, () => {
  let db: PgDb
  let other: PgDb

  beforeAll(async () => {
    db = await makeDb()
    await db.exec(`
      TRUNCATE users, sessions, api_tokens, tasks, jobs, usage_counters,
        email_tokens, warnings, blocks, audit_log RESTART IDENTITY CASCADE
    `)
    other = URL ? await PgDb.create(URL) : db
  }, 60_000)

  afterAll(async () => {
    // without a real server, `other` is the same embedded instance
    if (other && other !== db) await other.close()
    await db?.close()
  })

  it('round-trips users, sessions and usage counters', async () => {
    const user = await db.createUser({
      id: 'pg-user-1',
      email: 'Pg@Example.test',
      name: 'pg',
      password_hash: 'hash',
      role: 'user',
      status: 'active',
      plan: 'free',
      quota_json: '{}',
      email_verified: 1,
    })
    expect(user.email).toBe('pg@example.test')

    await db.createSession('session-hash-1', user.id, new Date(Date.now() + 60_000).toISOString())
    const viaSession = await other.getUserBySessionHash('session-hash-1')
    expect(viaSession?.id).toBe(user.id)

    await db.incrUsage(user.id, 'capture', '2026-01-01')
    await other.incrUsage(user.id, 'capture', '2026-01-01', 2)
    expect(await db.getUsage(user.id, '2026-01-01')).toEqual({ capture: 3 })
  })

  it('stores tasks and reports owner-scoped lists', async () => {
    await db.insertTask({
      id: 'pg-task-1',
      owner_id: 'pg-user-1',
      status: 'queued',
      input_json: JSON.stringify({ type: 'url', source: 'https://example.com' }),
      options_json: '{}',
      progress_json: '[]',
      loop_json: '{}',
      verifications_json: '[]',
      generations_json: '[]',
      result_json: null,
      worker_json: '{}',
      size_bytes: 0,
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    expect(await other.listTasks('pg-user-1')).toHaveLength(1)
    expect(await other.listTasks('someone-else')).toHaveLength(0)
    expect(await db.countTasks('pg-user-1')).toBe(1)

    await db.updateTask('pg-task-1', { status: 'done', size_bytes: 1024 })
    const task = await other.getTask('pg-task-1')
    expect(task?.status).toBe('done')
    expect(Number(task?.size_bytes)).toBe(1024)
    expect(await db.sumStorage('pg-user-1')).toBe(1024)
  })

  it('claims each job exactly once across pools (SKIP LOCKED)', async () => {
    for (const id of ['pg-job-1', 'pg-job-2']) {
      await db.enqueueJob({
        id,
        kind: 'capture',
        task_id: `task-${id}`,
        owner_id: 'pg-user-1',
        payload_json: '{}',
        status: 'queued',
        instance_id: null,
        error: null,
        created_at: new Date().toISOString(),
        started_at: null,
        finished_at: null,
      })
    }

    const [a, b] = await Promise.all([db.claimJob('instance-a'), other.claimJob('instance-b')])
    const claimed = [a, b].filter(Boolean)
    expect(claimed).toHaveLength(2)
    expect(new Set(claimed.map((j) => j!.id)).size).toBe(2)
    expect(await db.claimJob('instance-c')).toBeUndefined()

    await db.finishJob(claimed[0]!.id, 'done')
    await db.finishJob(claimed[1]!.id, 'failed', 'boom')
    const finished = await other.listJobs()
    expect(finished.map((j) => j.status).sort()).toEqual(['done', 'failed'])
  })

  it('requeues stale running jobs', async () => {
    await db.enqueueJob({
      id: 'pg-job-stale',
      kind: 'verify',
      task_id: 'task-stale',
      owner_id: 'pg-user-1',
      payload_json: '{"verificationId":"v1"}',
      status: 'queued',
      instance_id: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
    })
    const claimed = await db.claimJob('dead-instance')
    expect(claimed?.id).toBe('pg-job-stale')
    await db.exec("UPDATE jobs SET started_at = (now() - interval '40 minutes')::text")
    expect(await other.requeueStaleJobs(30 * 60_000)).toBeGreaterThanOrEqual(1)
    // also clean up the finished jobs from the previous test
    await db.exec("DELETE FROM jobs WHERE id IN ('pg-job-1','pg-job-2')")
    const reclaimed = await db.claimJob('instance-a')
    expect(reclaimed?.id).toBe('pg-job-stale')
    await db.finishJob('pg-job-stale', 'done')
  })

  it('blocks domains (subdomains included) and records audit entries', async () => {
    await db.addBlock({
      id: 'pg-block-1',
      kind: 'domain',
      value: 'example.com',
      note: null,
      created_at: new Date().toISOString(),
    })
    expect(await other.isDomainBlocked('example.com')).toBe(true)
    expect(await other.isDomainBlocked('sub.example.com')).toBe(true)
    expect(await other.isDomainBlocked('notexample.com')).toBe(false)

    await db.audit('pg-user-1', 'test.action', { ok: true })
    const entries = await other.listAudit(10)
    expect(entries[0].action).toBe('test.action')
  })

  it('runs the full capture pipeline on the Postgres backend', async () => {
    const fixture = await serveStatic(path.resolve(__dirname, '../../../fixtures/site'))
    const dataDir = await mkdtemp(path.join(tmpdir(), 'cp-pg-server-'))
    const store = await makeDb()
    const server = await startServer({
      port: 0,
      dataDir,
      db: store,
      allowPrivateNetwork: true,
    })
    try {
      const created = await fetch(`${server.url}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'url',
          source: fixture.url,
          options: { viewports: [800], dynamic: false, states: false },
        }),
      })
      expect(created.status).toBe(201)
      const { task } = (await created.json()) as { task: Task }

      const deadline = Date.now() + 90_000
      let done: Task | undefined
      while (Date.now() < deadline) {
        const res = await fetch(`${server.url}/api/tasks/${task.id}`)
        const body = (await res.json()) as { task: Task }
        if (body.task.status === 'done' || body.task.status === 'failed') {
          done = body.task
          break
        }
        await new Promise((r) => setTimeout(r, 300))
      }
      expect(done?.status).toBe('done')
      expect(done?.result?.title).toBe('CopyPage Fixture Site')

      // the shared queue row finished too
      const job = (await store.listJobs()).find((j) => j.task_id === task.id)
      expect(job?.status).toBe('done')
    } finally {
      await server.close()
      await fixture.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  }, 120_000)

  it('dedupes warnings per user and kind', async () => {
    const now = new Date().toISOString()
    await db.createWarning({
      id: 'pg-warning-1',
      user_id: 'pg-user-1',
      kind: 'quota',
      message: 'first',
      acknowledged: 0,
      created_at: now,
    })
    expect(await other.recentWarning('pg-user-1', 'quota', 24)).toBeTruthy()
    expect(await other.recentWarning('pg-user-1', 'blocked_domain', 24)).toBeUndefined()
    expect((await other.listWarnings('pg-user-1')).length).toBe(1)
    expect(await other.acknowledgeWarning('pg-user-1', 'pg-warning-1')).toBe(true)
  })
})
