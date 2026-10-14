import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic, type StaticServer } from '@copypage/core'
import { startServer, type RunningServer } from '../src/index.js'
import type { Task, Verification } from '../src/types.js'

const exec = promisify(execFile)
const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')
const MUTATED_FIXTURE = path.resolve(__dirname, '../../../fixtures/site-mutated')
const STUB_AGENT = path.resolve(__dirname, '../../../fixtures/agent-stub/stub-agent.mjs')

async function pollTask(base: string, id: string, timeoutMs = 90_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/tasks/${id}`)
    const { task } = (await res.json()) as { task: Task }
    if (task.status === 'done' || task.status === 'failed') return task
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('task did not finish in time')
}

async function pollVerification(
  base: string,
  taskId: string,
  verificationId: string,
  timeoutMs = 90_000,
): Promise<Verification> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { task } = (await (await fetch(`${base}/api/tasks/${taskId}`)).json()) as { task: Task }
    const v = task.verifications.find((x) => x.id === verificationId)
    if (v && (v.status === 'done' || v.status === 'failed')) return v
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('verification did not finish in time')
}

describe('capture service', () => {
  let fixture: StaticServer
  let server: RunningServer
  let dataDir: string

  beforeAll(async () => {
    fixture = await serveStatic(FIXTURE)
    dataDir = await mkdtemp(path.join(tmpdir(), 'cp-server-'))
    // fixtures live on loopback: this server explicitly opts into local-network captures
    server = await startServer({ port: 0, dataDir, allowPrivateNetwork: true })
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await fixture.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('rejects invalid task input', async () => {
    const res = await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'nope', source: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('captures a URL through the queue and serves artifacts', async () => {
    // SSE connection started before the task, so the stream must carry its updates
    const res = await fetch(`${server.url}/api/events`)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let stream = ''
    const readUntil = async (pred: (s: string) => boolean, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        stream += decoder.decode(value)
        if (pred(stream)) return
      }
      throw new Error(`SSE timeout; received:\n${stream.slice(-500)}`)
    }

    await readUntil((s) => s.includes('event: hello'))

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

    await readUntil((s) => s.includes(task.id) && s.includes('"status":"running"'))
    const done = await pollTask(server.url, task.id)
    reader.cancel().catch(() => {})

    expect(done.status).toBe('done')
    expect(done.result?.title).toBe('CopyPage Fixture Site')
    expect(done.result?.viewports).toEqual([800])
    expect(done.result?.domNodes).toBeGreaterThan(20)
    expect(done.progress.length).toBeGreaterThan(2)

    const shotRel = done.result!.screenshots['800']
    const shot = await fetch(`${server.url}/api/tasks/${task.id}/artifacts/${shotRel}`)
    expect(shot.status).toBe(200)
    expect(shot.headers.get('content-type')).toBe('image/png')
    expect((await shot.arrayBuffer()).byteLength).toBeGreaterThan(100)

    const snapshot = await fetch(`${server.url}/api/tasks/${task.id}/artifacts/snapshot.json`)
    expect(snapshot.status).toBe(200)
    const parsed = (await snapshot.json()) as { input: { type: string } }
    expect(parsed.input.type).toBe('url')
  }, 120_000)

  it('blocks path traversal on artifacts', async () => {
    const tasks = await server.store.list()
    const id = tasks[0].id
    const res = await fetch(
      `${server.url}/api/tasks/${id}/artifacts/${encodeURIComponent('../../task.json')}`,
    )
    expect(res.status).toBe(403)
  })

  it('verifies a repro path through the full pipeline', async () => {
    const task = (await server.store.list()).find((t) => t.status === 'done')!
    const res = await fetch(`${server.url}/api/tasks/${task.id}/verifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repro: { type: 'path', source: MUTATED_FIXTURE } }),
    })
    expect(res.status).toBe(201)
    const { verification } = (await res.json()) as { verification: Verification }

    const done = await pollVerification(server.url, task.id, verification.id)
    expect(done.status).toBe('done')
    expect(done.result!.metrics.pixelDiffPct).toBeGreaterThan(0)
    expect(done.result!.entries).toBeGreaterThan(0)
    expect(['pass', 'continue', 'escalate', 'stagnant-stop', 'cap-stop']).toContain(
      done.result!.decision,
    )

    // report is servable and its relative screenshot references resolve
    const reportUrl = `${server.url}/api/tasks/${task.id}/files/verifications/${verification.id}/${done.result!.report}`
    const report = await fetch(reportUrl)
    expect(report.status).toBe(200)
    expect(report.headers.get('content-type')).toContain('text/html')
    const html = await report.text()
    expect(html).toContain('Kloon 还原报告')
    expect(html).toContain('../../orig/screenshots/')

    const heat = await fetch(
      `${server.url}/api/tasks/${task.id}/files/verifications/${verification.id}/${done.result!.heatmaps[0]}`,
    )
    expect(heat.status).toBe(200)
    expect(heat.headers.get('content-type')).toBe('image/png')

    // verification runs are persisted on the task and the loop state advanced
    const reloaded = (await server.store.get(task.id))!
    expect(reloaded.loop.round).toBe(done.round)
    expect(reloaded.loop.history).toHaveLength(1)
  }, 120_000)

  it('verifies an uploaded zip', async () => {
    const task = (await server.store.list()).find((t) => t.status === 'done')!
    const zip = path.join(dataDir, 'mutated-repro.zip')
    await exec('bsdtar', ['-a', '-cf', zip, '-C', MUTATED_FIXTURE, '.'])

    const res = await fetch(`${server.url}/api/tasks/${task.id}/verifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip', 'x-filename': 'mutated-repro.zip' },
      body: await readFile(zip),
    })
    expect(res.status).toBe(201)
    const { verification } = (await res.json()) as { verification: Verification }

    const done = await pollVerification(server.url, task.id, verification.id)
    expect(done.status).toBe('done')
    expect(done.repro.type).toBe('zip')
    expect(done.result!.metrics.pixelDiffPct).toBeGreaterThan(0)
    expect(done.round).toBe(2)
  }, 120_000)

  it('blocks traversal on the files endpoint', async () => {
    const task = (await server.store.list())[0]
    const res = await fetch(
      `${server.url}/api/tasks/${task.id}/files/${encodeURIComponent('../../../etc/passwd')}`,
    )
    expect(res.status).toBe(403)
  })

  it('lists tasks and reports health', async () => {
    const list = await (await fetch(`${server.url}/api/tasks`)).json()
    expect(Array.isArray(list.tasks)).toBe(true)
    expect(list.tasks.length).toBeGreaterThan(0)
    const health = await (await fetch(`${server.url}/api/health`)).json()
    expect(health.ok).toBe(true)
  })

  it('refuses agent generation when the server has not opted in', async () => {
    const task = (await server.store.list()).find((t) => t.status === 'done')!
    const res = await fetch(`${server.url}/api/tasks/${task.id}/generate`, { method: 'POST' })
    expect(res.status).toBe(403)
  })
})

describe('agent generation', () => {
  let fixture: StaticServer
  let server: RunningServer
  let dataDir: string

  beforeAll(async () => {
    fixture = await serveStatic(FIXTURE)
    dataDir = await mkdtemp(path.join(tmpdir(), 'cp-gen-server-'))
    server = await startServer({
      port: 0,
      dataDir,
      allowPrivateNetwork: true,
      allowAgent: true,
      agentCommand: 'node',
      agentArgs: [STUB_AGENT],
      agentMaxRounds: 4,
    })
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await fixture.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('runs agent rounds, verifies each round and converges to pass', async () => {
    const created = await (await fetch(`${server.url}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'url',
        source: fixture.url,
        options: { viewports: [800], dynamic: false, states: false },
      }),
    })).json()
    await pollTask(server.url, created.task.id)

    const res = await fetch(`${server.url}/api/tasks/${created.task.id}/generate`, { method: 'POST' })
    expect(res.status).toBe(201)
    const { generation } = (await res.json()) as { generation: { id: string } }

    const deadline = Date.now() + 120_000
    let done: Task | undefined
    while (Date.now() < deadline) {
      const { task } = (await (await fetch(`${server.url}/api/tasks/${created.task.id}`)).json()) as { task: Task }
      const g = task.generations.find((x) => x.id === generation.id)
      if (g && (g.status === 'done' || g.status === 'failed')) {
        done = task
        break
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(done, 'generation did not finish').toBeDefined()

    const gen = done!.generations.find((x) => x.id === generation.id)!
    expect(gen.status).toBe('done')
    expect(gen.finalDecision).toBe('pass')
    expect(gen.rounds.length).toBe(2)
    expect(gen.rounds[0].metrics.pixelDiffPct).toBeGreaterThan(2)
    expect(gen.rounds[1].metrics.ssim).toBeGreaterThan(0.99)
    expect(gen.progress.some((p) => p.message.includes('[agent]'))).toBe(true)
    expect(gen.progress.some((p) => p.message.includes('round 2/4'))).toBe(true)

    // every round left a verification record; the first continued, the second passed
    const rounds = done!.verifications.sort((a, b) => a.round - b.round)
    expect(rounds).toHaveLength(2)
    expect(rounds[0].result?.decision).toBe('continue')
    expect(rounds[1].result?.decision).toBe('pass')
    expect(done!.loop.history).toHaveLength(2)

    // the generated project is the round-2 fixture and is served under files/
    const index = await fetch(
      `${server.url}/api/tasks/${created.task.id}/files/generated-repro/index.html`,
    )
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('Clone me if you can')
  }, 180_000)
})
