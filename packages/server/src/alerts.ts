import type { ServerConfig } from './config.js'
import type { Db } from './db.js'
import type { EmailClient } from './email.js'
import { alertEmail } from './email.js'
import type { Metrics } from './metrics.js'
import type { TaskStore } from './store.js'

export interface AlertState {
  /** last time each rule fired (dedupe) */
  lastFired: Map<string, number>
}

export interface AlertRuleInputs {
  queueDepth: number
  runningJobs: number
  recent: { started: number; failed: number }
  diskUsedPct: number
  storageBytes: number
}

export interface AlertEvent {
  rule: string
  title: string
  detail: string
}

const DEDUPE_MS = 30 * 60_000

/**
 * Evaluate operator alert rules. Pure enough to unit test: callers pass the
 * current inputs and receive the alerts that should fire.
 */
export function evaluateAlerts(
  inputs: AlertRuleInputs,
  state: AlertState,
  now = Date.now(),
): AlertEvent[] {
  const alerts: AlertEvent[] = []
  const fire = (rule: string, title: string, detail: string) => {
    const last = state.lastFired.get(rule)
    if (last !== undefined && now - last < DEDUPE_MS) return
    state.lastFired.set(rule, now)
    alerts.push({ rule, title, detail })
  }

  if (inputs.queueDepth >= 10) {
    fire('queue_backlog', '任务队列积压', `队列深度 ${inputs.queueDepth},运行中 ${inputs.runningJobs}`)
  }

  const samples = inputs.recent.started
  if (samples >= 5) {
    const failureRate = inputs.recent.failed / samples
    if (failureRate >= 0.5) {
      fire(
        'job_failure_rate',
        '任务失败率过高',
        `最近窗口 ${samples} 个任务,失败 ${inputs.recent.failed} 个(${Math.round(failureRate * 100)}%)`,
      )
    }
  }

  if (inputs.diskUsedPct >= 85) {
    fire(
      'disk_pressure',
      '磁盘水位告警',
      `数据目录已用 ${inputs.diskUsedPct.toFixed(1)}%(产物 ${Math.round(inputs.storageBytes / 1048576)}MB)`,
    )
  }

  return alerts
}

export interface AlertRunnerOptions {
  db: Db
  store: TaskStore
  metrics: Metrics
  config: ServerConfig
  email: EmailClient
  /** rolling job outcome window supplied by the queue */
  recentJobs: () => { started: number; failed: number }
  diskUsedPct: () => Promise<number>
  intervalMs?: number
  onProgress?: (message: string) => void
}

/** Periodic alert evaluation: audit log + optional operator email. */
export function startAlertRunner(opts: AlertRunnerOptions): { stop: () => void } {
  const state: AlertState = { lastFired: new Map() }
  const timer = setInterval(() => {
    void (async () => {
      try {
        const recent = opts.recentJobs()
        const alerts = evaluateAlerts(
          {
            queueDepth: opts.store.list().filter((t) => t.status === 'queued').length,
            runningJobs: opts.store.list().filter((t) => t.status === 'running').length,
            recent,
            diskUsedPct: await opts.diskUsedPct(),
            storageBytes: opts.db.sumStorage(),
          },
          state,
        )
        for (const alert of alerts) {
          opts.metrics.inc('copypage_alerts_total', { rule: alert.rule })
          opts.db.audit(null, `alert.${alert.rule}`, { detail: alert.detail })
          opts.onProgress?.(`[alert] ${alert.title}: ${alert.detail}`)
          if (opts.config.adminAlertEmail) {
            await opts.email
              .send(
                alertEmail(opts.config.adminAlertEmail, alert.title, [
                  alert.detail,
                  `时间: ${new Date().toISOString()}`,
                ]),
              )
              .catch((err) => console.error(`[email] alert send failed: ${String(err)}`))
          }
        }
      } catch (err) {
        console.error(`[alert] evaluation failed: ${String(err)}`)
      }
    })()
  }, opts.intervalMs ?? 60_000)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
