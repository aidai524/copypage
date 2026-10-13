import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { readSnapshot } from '@copypage/core'
import { captureImage, captureSite, captureVideo } from '@copypage/capture'
import { BuildError, captureRepro } from '@copypage/render'
import { decide, diffSnapshots, writeReport } from '@copypage/diff'
import type { TaskStore } from './store.js'
import type { TaskResult, VerificationResult } from './types.js'

export type QueueJob =
  | { kind: 'capture'; taskId: string }
  | { kind: 'verify'; taskId: string; verificationId: string }

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

function countNodes(root: { children: unknown[] }): number {
  let n = 0
  const walk = (node: { children: unknown[] }) => {
    n++
    for (const child of node.children) walk(child as { children: unknown[] })
  }
  walk(root)
  return n
}

/** Collect the numbers the UI shows after a capture finishes. */
export async function summarizeSnapshot(dir: string, durationMs: number): Promise<TaskResult> {
  const snapshot = await readSnapshot(dir)
  const meta = await readJson<{ title?: string }>(path.join(dir, 'meta.json'))
  const failed = (await readJson<unknown[]>(path.join(dir, 'assets-failed.json'))) ?? []
  const dismissed = (await readJson<unknown[]>(path.join(dir, 'dismissed.json'))) ?? []
  const dynamic = (await readJson<Record<string, unknown[]>>(path.join(dir, 'dynamic.json'))) ?? {}
  const assetsOk = (await readdir(path.join(dir, 'assets')).catch(() => [])).length

  let domNodes: number | undefined
  const firstDom = snapshot.dom?.[0]
  if (firstDom?.root) domNodes = countNodes(firstDom.root as unknown as { children: unknown[] })

  return {
    snapshotDir: dir,
    ...(meta?.title ? { title: meta.title } : {}),
    viewports: snapshot.viewports,
    screenshots: snapshot.screenshots,
    assetsOk,
    assetsFailed: failed.length,
    dynamicRegions: Object.values(dynamic).flat().length,
    dismissed: dismissed.length,
    ...(domNodes !== undefined ? { domNodes } : {}),
    durationMs,
  }
}

/**
 * Serial job queue: browser captures and repro verifications are memory/time
 * heavy, so jobs run one at a time in FIFO order. Progress streams back
 * through the store (and therefore SSE).
 */
export interface CaptureQueueOptions {
  /** run `npm run build` inside repro dirs; disabled by default in the server */
  allowBuild?: boolean
}

export class CaptureQueue {
  private pending: QueueJob[] = []
  private running = false
  private allowBuild: boolean

  constructor(private store: TaskStore, opts: CaptureQueueOptions = {}) {
    this.allowBuild = opts.allowBuild ?? true
  }

  /** queued + running jobs */
  get size(): number {
    return this.pending.length + (this.running ? 1 : 0)
  }

  enqueue(job: QueueJob): void {
    this.pending.push(job)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const job = this.pending.shift()
    if (!job) return
    this.running = true
    try {
      if (job.kind === 'capture') await this.runCapture(job.taskId)
      else await this.runVerification(job.taskId, job.verificationId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (job.kind === 'capture') {
        await this.store.appendProgress(job.taskId, `failed: ${message}`)
        await this.store.update(job.taskId, { status: 'failed', error: message })
      } else {
        await this.store.appendVerificationProgress(job.taskId, job.verificationId, `failed: ${message}`)
        await this.store.updateVerification(job.taskId, job.verificationId, {
          status: 'failed',
          error: message,
        })
      }
    } finally {
      this.running = false
      void this.pump()
    }
  }

  private async runCapture(id: string): Promise<void> {
    const task = this.store.get(id)
    if (!task) return
    const started = Date.now()
    await this.store.update(id, { status: 'running' })
    const outDir = this.store.snapshotDir(id)
    const onProgress = (message: string) => {
      void this.store.appendProgress(id, message)
    }

    const { input, options } = task
    if (input.type === 'url') {
      await captureSite(input.source, outDir, { ...options, onProgress })
    } else if (input.type === 'image') {
      onProgress(`image capture: ${input.source}`)
      await captureImage(input.source, outDir)
    } else {
      onProgress(`video capture: ${input.source}`)
      await captureVideo(input.source, outDir)
    }

    const result = await summarizeSnapshot(outDir, Date.now() - started)
    await this.store.update(id, { status: 'done', result })
  }

  /**
   * Verify a repro against the original capture with the exact same pipeline
   * used locally: captureRepro → diffSnapshots (dynamic masking included) →
   * writeReport → converge decision.
   */
  private async runVerification(taskId: string, verificationId: string): Promise<void> {
    const task = this.store.get(taskId)
    if (!task) return
    const verification = task.verifications.find((v) => v.id === verificationId)
    if (!verification) return

    const started = Date.now()
    const verDir = this.store.verificationDir(taskId, verificationId)
    const onProgress = (message: string) => {
      void this.store.appendVerificationProgress(taskId, verificationId, message)
    }
    await this.store.updateVerification(taskId, verificationId, { status: 'running' })

    const viewports = task.result?.viewports ?? [1440]
    const reproSnapDir = path.join(verDir, 'repro-snap')

    try {
      await captureRepro(verification.reproDir, reproSnapDir, {
        viewports,
        maxNodes: task.options.maxNodes ?? 12_000,
        allowBuild: this.allowBuild,
        onProgress,
      })
    } catch (err) {
      if (err instanceof BuildError) {
        await this.store.appendVerificationProgress(taskId, verificationId, 'repro build failed')
        await this.store.updateVerification(taskId, verificationId, {
          status: 'failed',
          error: `${err.message}${err.output ? `\n${err.output.slice(-4000)}` : ''}`,
        })
        return
      }
      throw err
    }

    const round = verification.round
    const diffsDir = path.join(verDir, 'diffs', `r${round}`)
    onProgress(`diffing (round ${round})`)
    const diff = await diffSnapshots(this.store.snapshotDir(taskId), reproSnapDir, diffsDir, {
      round,
    })

    // report.html sits in verDir; keep image references relative so it is
    // portable and directly servable by the files endpoint
    const origShots = viewports.map((w) => `../../orig/screenshots/${w}.png`)
    const reproShots = viewports.map((w) => `repro-snap/screenshots/${w}.png`)
    const reportPath = await writeReport(verDir, diff, origShots, reproShots)

    const decision = decide(task.loop, diff.metrics)
    await this.store.update(taskId, {
      loop: {
        round,
        history: [...task.loop.history, diff.metrics],
        escalated: task.loop.escalated || decision === 'escalate',
      },
    })

    const vlmPath = path.join(diffsDir, 'vlm-requests.json')
    const hasVlm = await stat(vlmPath).then(() => true).catch(() => false)

    const result: VerificationResult = {
      metrics: diff.metrics,
      decision,
      entries: diff.entries.length,
      topEntries: diff.entries.slice(0, 10).map((e) => ({
        severity: e.severity,
        element: e.element,
        property: e.property,
        expected: String(e.expected).slice(0, 140),
        actual: String(e.actual).slice(0, 140),
      })),
      report: path.relative(verDir, reportPath),
      heatmaps: viewports.map((w) => `diffs/r${round}/heatmap-${w}.png`),
      ...(hasVlm ? { vlmRequests: `diffs/r${round}/vlm-requests.json` } : {}),
      durationMs: Date.now() - started,
    }
    onProgress(
      `done: ssim ${result.metrics.ssim} · pixelDiff ${result.metrics.pixelDiffPct}%` +
        (result.metrics.dynamicAreaPct !== undefined
          ? ` · dynamic ${result.metrics.dynamicAreaPct}%`
          : '') +
        ` · ${decision}`,
    )
    await this.store.updateVerification(taskId, verificationId, { status: 'done', result })
  }
}
