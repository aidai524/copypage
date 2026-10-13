import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import type { Quota } from './config.js'
import {
  directorySize,
  type CaptureJobSpec,
  type GenerateJobSpec,
  type JobSpec,
  type VerifyJobSpec,
} from './jobs.js'
import type { TaskStore } from './store.js'
import type { WorkerEvent } from './types.js'

export interface QueueJob {
  kind: 'capture' | 'verify' | 'generate'
  taskId: string
  ownerId: string
  verificationId?: string
  generationId?: string
}

export interface CaptureQueueOptions {
  store: TaskStore
  /** repo root holding packages/ and skill/ (worker + agent cwd) */
  repoRoot?: string
  workerPath?: string
  tsxPath?: string
  /** jobs running at the same time across all tenants */
  concurrency?: number
  /** V8 heap limit per worker process */
  memoryMb?: number
  allowBuild?: boolean
  agent?: {
    command?: string
    args?: string[]
    model?: string
    maxRounds?: number
    timeoutMs?: number
  }
  /** per-tenant concurrency guard (the API also checks quotas at enqueue) */
  quotaForOwner?: (ownerId: string) => Quota
  /** failure signal for abuse/quality warnings (never throws back) */
  onJobFailed?: (info: {
    taskId: string
    ownerId: string
    kind: QueueJob['kind']
    error: string
  }) => void
}

const CAPTURE_TIMEOUT_MS = 20 * 60_000
const VERIFY_TIMEOUT_MS = 20 * 60_000
const GENERATE_MARGIN_MS = 10 * 60_000

/**
 * Job supervisor: FIFO queue with global + per-tenant concurrency limits.
 * Every job runs in its own worker process (crash containment, isolated env,
 * memory cap); task state is applied here so the API process stays responsive.
 */
export class CaptureQueue {
  private pending: QueueJob[] = []
  private running = 0
  private runningByOwner = new Map<string, number>()
  private store: TaskStore
  private repoRoot: string
  private workerPath: string
  private tsxPath: string
  private concurrency: number
  private memoryMb: number
  private allowBuild: boolean
  private agent: NonNullable<CaptureQueueOptions['agent']>
  private quotaForOwner: ((ownerId: string) => Quota) | undefined
  private onJobFailed: CaptureQueueOptions['onJobFailed']

  constructor(opts: CaptureQueueOptions) {
    if (!opts.store) throw new Error('CaptureQueue requires a store')
    this.store = opts.store
    this.repoRoot = opts.repoRoot ?? process.cwd()
    this.workerPath = opts.workerPath ?? path.join(this.repoRoot, 'packages/server/src/worker.ts')
    this.tsxPath = opts.tsxPath ?? path.join(this.repoRoot, 'node_modules/.bin/tsx')
    this.concurrency = Math.max(1, opts.concurrency ?? 2)
    this.memoryMb = opts.memoryMb ?? 3072
    this.allowBuild = opts.allowBuild ?? false
    this.agent = opts.agent ?? {}
    this.quotaForOwner = opts.quotaForOwner
    this.onJobFailed = opts.onJobFailed
  }

  private notifyFailure(job: QueueJob, error: string): void {
    try {
      this.onJobFailed?.({ taskId: job.taskId, ownerId: job.ownerId, kind: job.kind, error })
    } catch {
      // warnings must never break job supervision
    }
  }

  /** queued + running jobs */
  get size(): number {
    return this.pending.length + this.running
  }

  enqueue(job: QueueJob): void {
    this.pending.push(job)
    void this.pump()
  }

  private canStart(job: QueueJob): boolean {
    if (!this.quotaForOwner) return true
    const limit = this.quotaForOwner(job.ownerId).maxConcurrent
    return (this.runningByOwner.get(job.ownerId) ?? 0) < limit
  }

  private async pump(): Promise<void> {
    while (this.running < this.concurrency) {
      const index = this.pending.findIndex((job) => this.canStart(job))
      if (index < 0) return
      const [job] = this.pending.splice(index, 1)
      this.running++
      this.runningByOwner.set(job.ownerId, (this.runningByOwner.get(job.ownerId) ?? 0) + 1)
      void this.runJob(job)
        .catch(() => {})
        .finally(() => {
          this.running--
          const left = (this.runningByOwner.get(job.ownerId) ?? 1) - 1
          if (left <= 0) this.runningByOwner.delete(job.ownerId)
          else this.runningByOwner.set(job.ownerId, left)
          void this.pump()
        })
    }
  }

  private async runJob(job: QueueJob): Promise<void> {
    if (job.kind === 'capture') return this.runCapture(job)
    if (job.kind === 'verify') return this.runVerify(job)
    return this.runGenerate(job)
  }

  // ---------- capture ----------

  private async runCapture(job: QueueJob): Promise<void> {
    const task = this.store.get(job.taskId)
    if (!task) return
    await this.store.update(job.taskId, { status: 'running' })
    const spec: CaptureJobSpec = {
      kind: 'capture',
      taskId: task.id,
      snapshotDir: this.store.snapshotDir(task.id),
      input: task.input,
      options: task.options,
    }
    try {
      await this.spawnWorker(task.id, spec, CAPTURE_TIMEOUT_MS, async (event) => {
        if (event.type === 'progress') {
          await this.store.appendProgress(task.id, event.message)
        } else if (event.type === 'task-result') {
          await this.store.update(task.id, { status: 'done', result: event.result })
        }
      })
      const after = this.store.get(task.id)
      if (after && after.status === 'running') {
        await this.store.update(task.id, { status: 'done' })
      }
      await this.refreshSize(task.id)
    } catch (err) {
      await this.fail(job, err)
    }
  }

  // ---------- verification ----------

  private async runVerify(job: QueueJob): Promise<void> {
    const task = this.store.get(job.taskId)
    const verification = task?.verifications.find((v) => v.id === job.verificationId)
    if (!task || !verification) return
    await this.store.updateVerification(task.id, verification.id, { status: 'running' })

    const spec: VerifyJobSpec = {
      kind: 'verify',
      taskId: task.id,
      verificationId: verification.id,
      origDir: this.store.snapshotDir(task.id),
      reproDir: verification.reproDir,
      snapshotDir: path.join(this.store.verificationDir(task.id, verification.id), 'repro-snap'),
      verificationDir: this.store.verificationDir(task.id, verification.id),
      round: verification.round,
      viewports: task.result?.viewports ?? [1440],
      ...(task.options.maxNodes ? { maxNodes: task.options.maxNodes } : {}),
      allowBuild: this.allowBuild,
      loop: task.loop,
    }

    try {
      await this.spawnWorker(task.id, spec, VERIFY_TIMEOUT_MS, async (event) => {
        if (event.type === 'progress') {
          await this.store.appendVerificationProgress(task.id, verification.id, event.message)
        } else if (event.type === 'loop') {
          await this.store.update(task.id, { loop: event.loop })
        } else if (event.type === 'verification-result') {
          await this.store.updateVerification(task.id, verification.id, {
            status: 'done',
            result: event.result,
          })
        }
      })
      const current = this.store.get(task.id)?.verifications.find((v) => v.id === verification.id)
      if (current && current.status === 'running') {
        await this.store.updateVerification(task.id, verification.id, { status: 'done' })
      }
      await this.refreshSize(task.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        await this.store.appendVerificationProgress(task.id, verification.id, `failed: ${message}`)
        await this.store.updateVerification(task.id, verification.id, { status: 'failed', error: message })
      } catch {
        // task/verification gone
      }
      this.notifyFailure(job, message)
    }
  }

  // ---------- generation ----------

  private async runGenerate(job: QueueJob): Promise<void> {
    const task = this.store.get(job.taskId)
    const generation = task?.generations.find((g) => g.id === job.generationId)
    if (!task || !generation) return
    await this.store.updateGeneration(task.id, generation.id, { status: 'running' })

    const spec: GenerateJobSpec = {
      kind: 'generate',
      taskId: task.id,
      generationId: generation.id,
      origDir: this.store.snapshotDir(task.id),
      reproDir: generation.reproDir,
      viewports: task.result?.viewports ?? [1440],
      sessionId: generation.sessionId,
      repoRoot: this.repoRoot,
      agent: { ...this.agent, ...(generation.agent.model ? { model: generation.agent.model } : {}) },
      allowBuild: this.allowBuild,
      verificationBaseDir: path.join(this.store.taskDir(task.id), 'verifications'),
      loop: task.loop,
    }

    const maxRounds = this.agent.maxRounds ?? 8
    const agentTimeout = this.agent.timeoutMs ?? 30 * 60_000
    const timeout = maxRounds * agentTimeout + GENERATE_MARGIN_MS

    try {
      await this.spawnWorker(task.id, spec, timeout, async (event) => {
        if (event.type === 'progress') {
          await this.store.appendGenerationProgress(task.id, generation.id, event.message)
        } else if (event.type === 'loop') {
          await this.store.update(task.id, { loop: event.loop })
        } else if (event.type === 'verification') {
          const existing = this.store
            .get(task.id)
            ?.verifications.find((v) => v.id === event.id)
          if (!existing) {
            await this.store.createVerification(task.id, event.repro, event.reproDir, {
              id: event.id,
              round: event.round,
            })
          }
          await this.store.updateVerification(task.id, event.id, {
            status: event.status,
            ...(event.result ? { result: event.result } : {}),
            ...(event.error ? { error: event.error } : {}),
          })
        } else if (event.type === 'generation-result') {
          await this.store.updateGeneration(task.id, generation.id, {
            status: 'done',
            finalDecision: event.finalDecision,
            rounds: event.rounds,
          })
        }
      })
      const current = this.store.get(task.id)?.generations.find((g) => g.id === generation.id)
      if (current && current.status === 'running') {
        await this.store.updateGeneration(task.id, generation.id, { status: 'done' })
      }
      await this.refreshSize(task.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      try {
        await this.store.appendGenerationProgress(task.id, generation.id, `failed: ${message}`)
        await this.store.updateGeneration(task.id, generation.id, { status: 'failed', error: message })
      } catch {
        // task/generation gone
      }
      this.notifyFailure(job, message)
    }
  }

  // ---------- helpers ----------

  private async fail(job: QueueJob, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    // the task may have been deleted while the job ran: bookkeeping failures
    // must never suppress the failure signal
    try {
      await this.store.appendProgress(job.taskId, `failed: ${message}`)
      await this.store.update(job.taskId, { status: 'failed', error: message })
    } catch {
      // task gone
    }
    this.notifyFailure(job, message)
  }

  private async refreshSize(taskId: string): Promise<void> {
    const size = await directorySize(this.store.taskDir(taskId)).catch(() => 0)
    await this.store.setSize(taskId, size)
  }

  /**
   * Spawn the isolated worker for one job, stream its JSONL events through
   * onEvent in order, and resolve when it exits cleanly.
   */
  private spawnWorker(
    taskId: string,
    spec: JobSpec,
    timeoutMs: number,
    onEvent: (event: WorkerEvent) => Promise<void> | void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.tsxPath, [this.workerPath], {
        cwd: this.repoRoot,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${this.memoryMb}`.trim(),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let settled = false
      let errorEvent: string | undefined
      let stderrTail = ''
      let chain: Promise<void> = Promise.resolve()

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void chain.finally(fn)
      }

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000).unref()
        finish(() => reject(new Error(`worker timed out after ${Math.round(timeoutMs / 60000)}min`)))
      }, timeoutMs)
      timer.unref()

      child.on('spawn', () => {
        chain = chain.then(() =>
          this.store.update(taskId, {
            worker: { ...(child.pid ? { pid: child.pid } : {}), startedAt: new Date().toISOString() },
          }).then(() => undefined),
        )
      })

      const rl = createInterface({ input: child.stdout! })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) return
        let event: WorkerEvent
        try {
          event = JSON.parse(trimmed) as WorkerEvent
        } catch {
          return
        }
        if (event.type === 'error') {
          errorEvent = event.error
          return
        }
        chain = chain.then(() => Promise.resolve(onEvent(event)).then(() => undefined))
      })

      child.stderr!.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000)
      })

      child.on('error', (err) => {
        finish(() => reject(new Error(`cannot start worker: ${err.message}`)))
      })

      child.on('close', (code) => {
        if (errorEvent) {
          finish(() => reject(new Error(errorEvent)))
          return
        }
        if (code === 0) {
          finish(() => resolve())
          return
        }
        const detail = stderrTail.trim().split('\n').slice(-4).join('\n')
        finish(() => reject(new Error(`worker exited ${code}${detail ? `: ${detail}` : ''}`)))
      })

      child.stdin!.end(JSON.stringify(spec))
    })
  }
}
