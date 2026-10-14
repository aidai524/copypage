import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic, type StaticServer } from '@copypage/core'
import { startServer, type RunningServer } from '../src/index.js'
import { evaluateAlerts, type AlertState } from '../src/alerts.js'
import { Metrics } from '../src/metrics.js'

describe('Metrics', () => {
  it('renders counters, gauges and summaries in Prometheus format', () => {
    const metrics = new Metrics()
    metrics.inc('copypage_http_requests_total', { method: 'GET', route: '/api/tasks', status: 200 })
    metrics.inc('copypage_http_requests_total', { method: 'GET', route: '/api/tasks', status: 200 })
    metrics.inc('copypage_http_requests_total', { method: 'POST', route: '/api/tasks', status: 403 })
    metrics.gauge('copypage_queue_depth', 3, 'queued + running jobs')
    metrics.observe('copypage_job_duration_seconds', 1.5)

    const text = metrics.render()
    expect(text).toContain('# TYPE copypage_http_requests_total counter')
    expect(text).toContain('copypage_http_requests_total{method="GET",route="/api/tasks",status="200"} 2')
    expect(text).toContain('copypage_http_requests_total{method="POST",route="/api/tasks",status="403"} 1')
    expect(text).toContain('copypage_queue_depth 3')
    expect(text).toContain('copypage_job_duration_seconds_count 1')
    expect(metrics.snapshot()['copypage_queue_depth']).toBe(3)
  })
})

describe('evaluateAlerts', () => {
  const base = { queueDepth: 0, runningJobs: 0, recent: { started: 0, failed: 0 }, diskUsedPct: 10, storageBytes: 0 }

  it('fires backlog / failure-rate / disk rules', () => {
    const state: AlertState = { lastFired: new Map() }
    const alerts = evaluateAlerts(
      { ...base, queueDepth: 12, recent: { started: 10, failed: 6 }, diskUsedPct: 91 },
      state,
      1_000_000,
    )
    expect(alerts.map((a) => a.rule).sort()).toEqual(['disk_pressure', 'job_failure_rate', 'queue_backlog'])
  })

  it('ignores healthy inputs and dedupes within the window', () => {
    const state: AlertState = { lastFired: new Map() }
    expect(evaluateAlerts(base, state, 1_000_000)).toHaveLength(0)

    expect(evaluateAlerts({ ...base, queueDepth: 20 }, state, 2_000_000)).toHaveLength(1)
    // same rule inside the dedupe window → suppressed
    expect(evaluateAlerts({ ...base, queueDepth: 20 }, state, 3_000_000)).toHaveLength(0)
    // after the window it fires again
    expect(evaluateAlerts({ ...base, queueDepth: 20 }, state, 2_000_000 + 31 * 60_000)).toHaveLength(1)
  })

  it('needs a minimum sample before judging failure rate', () => {
    const state: AlertState = { lastFired: new Map() }
    expect(
      evaluateAlerts({ ...base, recent: { started: 2, failed: 2 } }, state, 1_000_000),
    ).toHaveLength(0)
  })
})

describe('GET /metrics', () => {
  let fixture: StaticServer
  let server: RunningServer
  let dataDir: string

  beforeAll(async () => {
    fixture = await serveStatic(path.resolve(__dirname, '../../../fixtures/site'))
    dataDir = await mkdtemp(path.join(tmpdir(), 'cp-metrics-'))
    server = await startServer({ port: 0, dataDir, allowPrivateNetwork: true })
  }, 60_000)

  afterAll(async () => {
    await server.close()
    await fixture.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('scrapes from loopback and reflects API + job activity', async () => {
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
    const { task } = (await created.json()) as { task: { id: string } }

    // wait for the worker job to run
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const res = await fetch(`${server.url}/api/tasks/${task.id}`)
      const body = (await res.json()) as { task: { status: string } }
      if (body.task.status === 'done' || body.task.status === 'failed') break
      await new Promise((r) => setTimeout(r, 300))
    }

    // job outcome metrics are recorded just after the task row flips to done:
    // poll briefly instead of racing that window
    const metricDeadline = Date.now() + 10_000
    let text = ''
    while (Date.now() < metricDeadline) {
      const res = await fetch(`${server.url}/metrics`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/plain')
      text = await res.text()
      if (text.includes('copypage_jobs_total{kind="capture",result="done"} 1')) break
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(text).toContain('copypage_http_requests_total{')
    expect(text).toMatch(/route="\/api\/tasks"/)
    expect(text).toContain('copypage_jobs_started_total{kind="capture"} 1')
    expect(text).toContain('copypage_jobs_total{kind="capture",result="done"} 1')
    expect(text).toContain('copypage_job_duration_seconds_count')
  }, 120_000)
})
