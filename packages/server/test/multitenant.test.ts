import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic, type StaticServer } from '@copypage/core'
import { DEFAULT_PLANS } from '../src/config.js'
import { startServer, type RunningServer } from '../src/index.js'
import type { Task } from '../src/types.js'

const exec = promisify(execFile)
const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')
const MUTATED_FIXTURE = path.resolve(__dirname, '../../../fixtures/site-mutated')

interface Client {
  cookie: string
  user: { id: string; email: string; role: string; plan: string }
}

async function register(base: string, email: string, password: string): Promise<Client> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.status, `register ${email}`).toBe(201)
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  const body = (await res.json()) as { user: Client['user'] }
  return { cookie, user: body.user }
}

function auth(client: Client, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), cookie: client.cookie } }
}

async function pollTask(base: string, client: Client, id: string, timeoutMs = 90_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/tasks/${id}`, auth(client))
    const { task } = (await res.json()) as { task: Task }
    if (task.status === 'done' || task.status === 'failed') return task
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('task did not finish in time')
}

describe('multi-tenant service', () => {
  let fixture: StaticServer
  let server: RunningServer
  let dataDir: string
  let alice: Client
  let bob: Client
  let admin: Client | undefined

  beforeAll(async () => {
    fixture = await serveStatic(FIXTURE)
    dataDir = await mkdtemp(path.join(tmpdir(), 'cp-mt-'))
    server = await startServer({
      port: 0,
      dataDir,
      allowRegistration: true,
      allowPrivateNetwork: true,
      adminEmail: 'admin@mt.test',
      adminPassword: 'adminpass123',
      plans: {
        ...DEFAULT_PLANS,
        free: { ...DEFAULT_PLANS.free, maxTasks: 2, maxVerificationsPerDay: 5 },
      },
    })
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await fixture.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('registers, logs in and reports identity + quota', async () => {
    alice = await register(server.url, 'alice@mt.test', 'alicepass123')
    bob = await register(server.url, 'bob@mt.test', 'bobpass123')
    expect(alice.user.role).toBe('user')

    const login = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@mt.test', password: 'alicepass123' }),
    })
    expect(login.status).toBe(200)

    const me = await fetch(`${server.url}/api/auth/me`, auth(alice))
    const payload = (await me.json()) as { quota: { maxTasks: number }; usage: Record<string, number> }
    expect(payload.quota.maxTasks).toBe(2)

    const badLogin = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@mt.test', password: 'wrong-password' }),
    })
    expect(badLogin.status).toBe(401)

    const logout = await fetch(`${server.url}/api/auth/logout`, { method: 'POST', ...auth(alice) })
    expect(logout.status).toBe(200)
    // the server-side session is gone: the old cookie no longer authenticates
    const afterLogout = await fetch(`${server.url}/api/tasks`, { headers: { cookie: alice.cookie } })
    expect(afterLogout.status).toBe(401)
    alice = await register(server.url, 'alice2@mt.test', 'alicepass123')
  })

  it('keeps tenants isolated', async () => {
    const created = await fetch(`${server.url}/api/tasks`, {
      ...auth(alice, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'url',
          source: fixture.url,
          options: { viewports: [800], dynamic: false, states: false },
        }),
      }),
    })
    expect(created.status).toBe(201)
    const { task } = (await created.json()) as { task: Task }
    const done = await pollTask(server.url, alice, task.id)
    expect(done.status).toBe('done')

    // bob cannot see, read, verify or delete alice's task
    const list = (await (await fetch(`${server.url}/api/tasks`, auth(bob))).json()) as { tasks: Task[] }
    expect(list.tasks).toHaveLength(0)
    expect((await fetch(`${server.url}/api/tasks/${task.id}`, auth(bob))).status).toBe(404)
    expect(
      (await fetch(`${server.url}/api/tasks/${task.id}/artifacts/snapshot.json`, auth(bob))).status,
    ).toBe(404)
    expect(
      (
        await fetch(`${server.url}/api/tasks/${task.id}/verifications`, {
          ...auth(bob, { method: 'POST', headers: { 'content-type': 'application/json' } }),
          body: JSON.stringify({ repro: { type: 'path', source: MUTATED_FIXTURE } }),
        })
      ).status,
    ).toBe(404)
    expect((await fetch(`${server.url}/api/tasks/${task.id}`, auth(bob, { method: 'DELETE' }))).status).toBe(404)

    // alice still owns it
    expect((await fetch(`${server.url}/api/tasks/${task.id}`, auth(alice))).status).toBe(200)

    // regular tenants may not use server-local repro paths
    const pathVerify = await fetch(`${server.url}/api/tasks/${task.id}/verifications`, {
      ...auth(alice, { method: 'POST', headers: { 'content-type': 'application/json' } }),
      body: JSON.stringify({ repro: { type: 'path', source: MUTATED_FIXTURE } }),
    })
    expect(pathVerify.status).toBe(403)

    // zip upload verification works for tenants and produces a report
    const zip = path.join(dataDir, 'tenant-repro.zip')
    await exec('bsdtar', ['-a', '-cf', zip, '-C', MUTATED_FIXTURE, '.'])
    const zipRes = await fetch(`${server.url}/api/tasks/${task.id}/verifications`, {
      ...auth(alice, {
        method: 'POST',
        headers: { 'content-type': 'application/zip', 'x-filename': 'tenant-repro.zip' },
      }),
      body: await readFile(zip),
    })
    expect(zipRes.status).toBe(201)
    const { verification } = (await zipRes.json()) as { verification: { id: string } }

    const deadline = Date.now() + 90_000
    let verified = false
    while (Date.now() < deadline) {
      const t = (await (await fetch(`${server.url}/api/tasks/${task.id}`, auth(alice))).json()) as {
        task: Task
      }
      const v = t.task.verifications.find((x) => x.id === verification.id)
      if (v && v.status === 'done') {
        verified = true
        expect(v.result?.report).toBe('report.html')
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(verified, 'zip verification completed').toBe(true)
  }, 180_000)

  it('enforces per-tenant quotas', async () => {
    // fill alice's task quota directly (maxTasks: 2, one used by the capture)
    await server.store.create(alice.user.id, { type: 'url', source: 'https://example.com' })
    const res = await fetch(`${server.url}/api/tasks`, {
      ...auth(alice, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'url', source: 'https://example.com/other' }),
      }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('quota_tasks')
  })

  it('lets the bootstrap admin log in and moderate', async () => {
    const login = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@mt.test', password: 'adminpass123' }),
    })
    expect(login.status).toBe(200)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const adminClient: Client = {
      cookie,
      user: ((await login.json()) as { user: Client['user'] }).user,
    }
    expect(adminClient.user.role).toBe('admin')

    const users = (await (
      await fetch(`${server.url}/api/admin/users`, auth(adminClient))
    ).json()) as { users: { id: string; email: string }[] }
    expect(users.users.some((u) => u.email === 'bob@mt.test')).toBe(true)

    // suspend bob → his requests are rejected
    const bobRow = users.users.find((u) => u.email === 'bob@mt.test')!
    const patched = await fetch(`${server.url}/api/admin/users/${bobRow.id}`, {
      ...auth(adminClient, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      }),
    })
    expect(patched.status).toBe(200)
    expect((await fetch(`${server.url}/api/tasks`, auth(bob))).status).toBe(403)

    // block a domain → captures for it are rejected even for admins
    const block = await fetch(`${server.url}/api/admin/blocks`, {
      ...auth(adminClient, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'domain', value: '127.0.0.1' }),
      }),
    })
    expect(block.status).toBe(201)
    const blocked = await fetch(`${server.url}/api/tasks`, {
      ...auth(adminClient, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'url', source: fixture.url }),
      }),
    })
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as { error: string }).error).toContain('domain blocked')

    const stats = (await (await fetch(`${server.url}/api/admin/stats`, auth(adminClient))).json()) as {
      users: number
    }
    expect(stats.users).toBeGreaterThanOrEqual(3)

    const audit = (await (
      await fetch(`${server.url}/api/admin/audit`, auth(adminClient))
    ).json()) as { entries: { action: string }[] }
    expect(audit.entries.some((e) => e.action === 'admin.user.update')).toBe(true)

    // non-admins cannot reach admin routes
    expect((await fetch(`${server.url}/api/admin/users`, auth(bob))).status).toBe(403)
  }, 60_000)

  it('authenticates API tokens per tenant', async () => {
    const created = await fetch(`${server.url}/api/tokens`, {
      ...auth(alice, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'ci' }),
      }),
    })
    expect(created.status).toBe(201)
    const { token } = (await created.json()) as { token: string }
    const viaToken = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(viaToken.status).toBe(200)
    const viaBadToken = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: 'Bearer cp_not-a-real-token' },
    })
    expect(viaBadToken.status).toBe(401)
  })

  it('rejects registration when closed', async () => {
    const closedDir = await mkdtemp(path.join(tmpdir(), 'cp-mt-closed-'))
    const closed = await startServer({
      port: 0,
      dataDir: closedDir,
      adminEmail: 'admin@closed.test',
      adminPassword: 'adminpass123',
    })
    try {
      const res = await fetch(`${closed.url}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'x@y.z', password: 'password123' }),
      })
      expect(res.status).toBe(403)
      // anonymous access is closed too
      expect((await fetch(`${closed.url}/api/tasks`)).status).toBe(401)
    } finally {
      await closed.close()
      await rm(closedDir, { recursive: true, force: true })
    }
  }, 30_000)
})
