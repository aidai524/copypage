import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { serveStatic, type StaticServer } from '@copypage/core'
import { SqliteDb as Db } from '../src/db.js'
import { startServer, type RunningServer } from '../src/index.js'
import type { Task } from '../src/types.js'

describe('job claiming (shared database)', () => {
  let dir: string
  let dbA: Db
  let dbB: Db

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-cluster-'))
    dbA = new Db(dir)
    dbB = new Db(dir)
  })

  afterAll(async () => {
    dbA.close()
    dbB.close()
    await rm(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    dbA.db.exec('DELETE FROM jobs')
  })

  it('claims a queued job exactly once', () => {
    dbA.enqueueJob({
      id: 'job-1',
      kind: 'capture',
      task_id: 'task-1',
      owner_id: 'u1',
      payload_json: '{}',
      status: 'queued',
      instance_id: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
    })

    const first = dbA.claimJob('instance-a')
    const second = dbB.claimJob('instance-b')
    expect(first?.id).toBe('job-1')
    expect(first?.instance_id).toBe('instance-a')
    expect(second).toBeUndefined()
    dbA.finishJob('job-1', 'done')
  })

  it('honors per-tenant exclusions when claiming', () => {
    for (const id of ['job-a', 'job-b']) {
      dbA.enqueueJob({
        id,
        kind: 'capture',
        task_id: `task-${id}`,
        owner_id: id === 'job-a' ? 'busy' : 'free',
        payload_json: '{}',
        status: 'queued',
        instance_id: null,
        error: null,
        created_at: new Date(Date.now() + (id === 'job-a' ? -1000 : 0)).toISOString(),
        started_at: null,
        finished_at: null,
      })
    }
    const claimed = dbA.claimJob('instance-a', ['busy'])
    expect(claimed?.owner_id).toBe('free')
    dbA.finishJob(claimed!.id, 'done')
  })

  it('requeues jobs whose instance died mid-run', () => {
    dbA.enqueueJob({
      id: 'job-stale',
      kind: 'verify',
      task_id: 'task-stale',
      owner_id: 'u1',
      payload_json: '{"verificationId":"v1"}',
      status: 'queued',
      instance_id: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
    })
    const claimed = dbB.claimJob('dead-instance')
    expect(claimed?.id).toBe('job-stale')
    // pretend the instance hung 40 minutes ago
    dbB.db
      .prepare('UPDATE jobs SET started_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 40 * 60_000).toISOString(), 'job-stale')
    expect(dbA.requeueStaleJobs(30 * 60_000)).toBe(1)
    const reclaimed = dbA.claimJob('instance-a')
    expect(reclaimed?.id).toBe('job-stale')
    dbA.finishJob('job-stale', 'done')
  })
})

describe('two instances over one data directory', () => {
  let fixture: StaticServer
  let dir: string
  let a: RunningServer
  let b: RunningServer

  beforeAll(async () => {
    fixture = await serveStatic(path.resolve(__dirname, '../../../fixtures/site'))
    dir = await mkdtemp(path.join(tmpdir(), 'cp-cluster2-'))
    a = await startServer({ port: 0, dataDir: dir, allowPrivateNetwork: true, allowRegistration: true })
    b = await startServer({ port: 0, dataDir: dir, allowPrivateNetwork: true, allowRegistration: true })
  }, 120_000)

  afterAll(async () => {
    await a.close()
    await b.close()
    await fixture.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('streams task updates created on another instance (SSE polling)', async () => {
    const register = await fetch(`${a.url}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'cluster@test.dev', password: 'clusterpass123' }),
    })
    expect(register.status).toBe(201)
    const cookie = (register.headers.get('set-cookie') ?? '').split(';')[0]

    // SSE from instance B, task created on instance A
    const sse = await fetch(`${b.url}/api/events`, { headers: { cookie } })
    expect(sse.status).toBe(200)
    const reader = sse.body!.getReader()
    const decoder = new TextDecoder()
    let stream = ''

    const created = await fetch(`${a.url}/api/tasks`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
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
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      stream += decoder.decode(value)
      for (const line of stream.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const payload = JSON.parse(line.slice(6)) as Task
          if (payload.id === task.id && payload.status === 'done') done = payload
        } catch {
          // partial line
        }
      }
      if (done) break
    }
    reader.cancel().catch(() => {})
    expect(done, 'instance B streamed the completion').toBeDefined()
    expect(done!.result?.title).toBe('CopyPage Fixture Site')

    // both instances can read the finished task
    for (const server of [a, b]) {
      const res = await (await fetch(`${server.url}/api/tasks/${task.id}`, { headers: { cookie } })).json() as {
        task: Task
      }
      expect(res.task.status).toBe('done')
    }

    // the queue row is finished, not stuck in running
    const job = a.db.listJobs().find((j) => j.task_id === task.id)
    expect(job?.status).toBe('done')
  }, 180_000)
})
