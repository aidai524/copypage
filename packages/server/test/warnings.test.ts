import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_PLANS } from '../src/config.js'
import { startServer, type RunningServer } from '../src/index.js'

interface Warning {
  id: string
  kind: string
  message: string
  acknowledged: number
}

interface Client {
  cookie: string
  user: { id: string; email: string }
}

async function register(base: string, email: string, password: string): Promise<Client> {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  expect(res.status).toBe(201)
  return {
    cookie: (res.headers.get('set-cookie') ?? '').split(';')[0],
    user: ((await res.json()) as { user: Client['user'] }).user,
  }
}

describe('warnings', () => {
  let server: RunningServer
  let dataDir: string
  let user: Client
  let admin: Client

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'cp-warn-'))
    server = await startServer({
      port: 0,
      dataDir,
      allowRegistration: true,
      allowPrivateNetwork: true,
      adminEmail: 'admin@warn.test',
      adminPassword: 'adminpass123',
      plans: { ...DEFAULT_PLANS, free: { ...DEFAULT_PLANS.free, maxTasks: 1, maxCapturesPerDay: 100 } },
    })
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('warns a tenant when the quota is exceeded (deduplicated)', async () => {
    user = await register(server.url, 'warned@warn.test', 'warnpass123')
    await server.store.create(user.user.id, { type: 'url', source: 'https://example.com' })

    const blocked = await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url', source: 'https://example.com/two' }),
    })
    expect(blocked.status).toBe(403)

    const list = (await (
      await fetch(`${server.url}/api/warnings`, { headers: { cookie: user.cookie } })
    ).json()) as { warnings: Warning[] }
    expect(list.warnings.some((w) => w.kind === 'quota')).toBe(true)

    // acking works and persists
    const quotaWarning = list.warnings.find((w) => w.kind === 'quota')!
    const ack = await fetch(`${server.url}/api/warnings/${quotaWarning.id}/ack`, {
      method: 'POST',
      headers: { cookie: user.cookie },
    })
    expect(ack.status).toBe(200)
    const after = (await (
      await fetch(`${server.url}/api/warnings`, { headers: { cookie: user.cookie } })
    ).json()) as { warnings: Warning[] }
    expect(after.warnings.find((w) => w.id === quotaWarning.id)!.acknowledged).toBe(1)
  }, 60_000)

  it('surfaces warnings on /api/auth/me and lets admins send notices', async () => {
    const login = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@warn.test', password: 'adminpass123' }),
    })
    admin = {
      cookie: (login.headers.get('set-cookie') ?? '').split(';')[0],
      user: ((await login.json()) as { user: Client['user'] }).user,
    }

    const sent = await fetch(`${server.url}/api/admin/warnings`, {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: user.user.id, message: '请勿高频抓取同一站点' }),
    })
    expect(sent.status).toBe(201)

    const me = (await (
      await fetch(`${server.url}/api/auth/me`, { headers: { cookie: user.cookie } })
    ).json()) as { warnings: Warning[] }
    expect(me.warnings.some((w) => w.kind === 'manual' && w.message.includes('高频'))).toBe(true)

    const adminList = (await (
      await fetch(`${server.url}/api/admin/warnings`, { headers: { cookie: admin.cookie } })
    ).json()) as { warnings: Warning[] }
    expect(adminList.warnings.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('flags repeated job failures for the operator', async () => {
    // drop the quota-ballast task and raise the override so three jobs fit
    for (const task of server.store.list(user.user.id)) await server.store.delete(task.id)
    const patched = await fetch(`${server.url}/api/admin/users/${user.user.id}`, {
      method: 'PATCH',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ quota: { maxTasks: 10, maxCapturesPerDay: 100, maxConcurrent: 3 } }),
    })
    expect(patched.status).toBe(200)

    // port 81 on a public host resolves but refuses connections → the worker fails
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${server.url}/api/tasks`, {
        method: 'POST',
        headers: { cookie: user.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'url', source: 'https://example.com:81/', options: { viewports: [800] } }),
      })
      expect(res.status, `job ${i + 1} accepted`).toBe(201)
    }

    const deadline = Date.now() + 60_000
    let warned = false
    while (Date.now() < deadline) {
      const warnings = server.db.listWarnings(user.user.id)
      if (warnings.some((w) => w.kind === 'repeated_failures')) {
        warned = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(warned, 'repeated_failures warning recorded').toBe(true)
  }, 180_000)
})
