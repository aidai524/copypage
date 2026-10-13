import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer, type RunningServer } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { isPrivateAddress, assertPublicUrl } from '../src/security.js'
import type { Task, Verification } from '../src/types.js'

async function pollVerification(
  base: string,
  taskId: string,
  verificationId: string,
  timeoutMs = 30_000,
): Promise<Verification> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { task } = (await (
      await fetch(`${base}/api/tasks/${taskId}`, {
        headers: { authorization: 'Bearer secret-test' },
      })
    ).json()) as { task: Task }
    const v = task.verifications.find((x) => x.id === verificationId)
    if (v && (v.status === 'done' || v.status === 'failed')) return v
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('verification did not finish in time')
}

describe('isPrivateAddress', () => {
  it('blocks loopback, private, link-local and mapped addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
  })

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })
})

describe('assertPublicUrl', () => {
  it('rejects non-http schemes and private hosts', async () => {
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow('http/https')
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow('blocked non-public address')
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      'blocked',
    )
    await expect(assertPublicUrl('http://localhost:8080/')).rejects.toThrow('blocked')
  })

  it('accepts private hosts only when explicitly allowed', async () => {
    const url = await assertPublicUrl('http://127.0.0.1:9999/', { allowPrivateNetwork: true })
    expect(url.port).toBe('9999')
  })
})

describe('service security', () => {
  let server: RunningServer
  let dataDir: string
  let reproDir: string

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'cp-security-'))
    reproDir = await mkdtemp(path.join(tmpdir(), 'cp-security-repro-'))
    // a project with package.json but no built dist: server-side build must refuse it
    await writeFile(
      path.join(reproDir, 'package.json'),
      JSON.stringify({ name: 'evil', scripts: { build: 'touch /tmp/pwned' } }),
    )
    await writeFile(path.join(reproDir, 'index.html'), '<html></html>')
    server = await startServer({ port: 0, dataDir, token: 'secret-test' })
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await rm(dataDir, { recursive: true, force: true })
    await rm(reproDir, { recursive: true, force: true })
  })

  it('requires the bearer token on all api routes', async () => {
    expect((await fetch(`${server.url}/api/tasks`)).status).toBe(401)
    expect((await fetch(`${server.url}/api/health`)).status).toBe(401)
    const ok = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: 'Bearer secret-test' },
    })
    expect(ok.status).toBe(200)
    const viaQuery = await fetch(`${server.url}/api/tasks?token=secret-test`)
    expect(viaQuery.status).toBe(200)
  })

  it('rejects SSRF targets by default', async () => {
    const res = await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-test', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url', source: 'http://169.254.169.254/latest/meta-data/' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('blocked')
  })

  it('refuses to build submitted projects (RCE guard)', async () => {
    const task = await server.store.create({ type: 'url', source: 'https://example.com' })
    await server.store.update(task.id, {
      status: 'done',
      result: {
        snapshotDir: server.store.snapshotDir(task.id),
        viewports: [800],
        screenshots: { '800': 'screenshots/800.png' },
        assetsOk: 0,
        assetsFailed: 0,
        dynamicRegions: 0,
        dismissed: 0,
        durationMs: 0,
      },
    })

    const res = await fetch(`${server.url}/api/tasks/${task.id}/verifications`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-test', 'content-type': 'application/json' },
      body: JSON.stringify({ repro: { type: 'path', source: reproDir } }),
    })
    expect(res.status).toBe(201)
    const { verification } = (await res.json()) as { verification: Verification }

    const done = await pollVerification(server.url, task.id, verification.id)
    expect(done.status).toBe('failed')
    expect(done.error).toContain('server-side build is disabled')
  }, 30_000)

  it('enforces the task quota', async () => {
    const limited = await startServer({
      port: 0,
      dataDir: await mkdtemp(path.join(tmpdir(), 'cp-quota-')),
      maxTasks: 1,
      allowPrivateNetwork: true,
    })
    try {
      const create = (source: string) =>
        fetch(`${limited.url}/api/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'url', source }),
        })
      expect((await create('http://127.0.0.1:9/')).status).toBe(201)
      expect((await create('http://127.0.0.1:9/')).status).toBe(507)
    } finally {
      await limited.close()
      await rm(limited.config.dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('refuses to bind a non-loopback host without a token', () => {
    expect(() => resolveConfig({ host: '0.0.0.0' })).toThrow('refusing to bind')
  })

  it('creates verification dirs and can clean up expired tasks', async () => {
    const task = await server.store.create({ type: 'url', source: 'https://example.com' })
    await server.store.update(task.id, { status: 'done' })
    // backdate the in-memory record so the retention sweep considers it expired
    server.store.get(task.id)!.updatedAt = new Date(Date.now() - 10_000).toISOString()
    const removed = await server.store.cleanupOlderThan(500)
    expect(removed).toContain(task.id)
    expect(server.store.get(task.id)).toBeUndefined()
  })

  it('rejects path traversal through the files endpoint', async () => {
    const task = await server.store.create({ type: 'url', source: 'https://example.com' })
    await mkdir(server.store.taskDir(task.id), { recursive: true })
    const res = await fetch(
      `${server.url}/api/tasks/${task.id}/files/${encodeURIComponent('../../task.json')}?token=secret-test`,
    )
    expect(res.status).toBe(403)
  })
})
