import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { readSnapshot } from '@copypage/core'
import { captureImage, captureSite, captureVideo } from '@copypage/capture'
import { captureRepro } from '@copypage/render'
import { decide, diffSnapshots, writeReport } from '@copypage/diff'
import { runGenerationLoop } from '@copypage/generator'
import type {
  CaptureJobOptions,
  LoopState,
  TaskInput,
  TaskResult,
  VerificationResult,
  WorkerEvent,
} from './types.js'

/**
 * Job execution bodies shared by the in-process runner and the isolated worker
 * process. They only touch the filesystem and stream progress/result events —
 * database and task bookkeeping stay with the supervisor.
 */

export interface CaptureJobSpec {
  kind: 'capture'
  taskId: string
  snapshotDir: string
  input: TaskInput
  options: CaptureJobOptions
}

export interface VerifyJobSpec {
  kind: 'verify'
  taskId: string
  verificationId: string
  origDir: string
  reproDir: string
  snapshotDir: string
  verificationDir: string
  round: number
  viewports: number[]
  maxNodes?: number
  allowBuild: boolean
  loop: LoopState
}

export interface GenerateJobSpec {
  kind: 'generate'
  taskId: string
  generationId: string
  origDir: string
  reproDir: string
  viewports: number[]
  sessionId: string
  repoRoot: string
  agent: {
    command?: string
    args?: string[]
    model?: string
    maxRounds?: number
    timeoutMs?: number
  }
  allowBuild: boolean
  verificationBaseDir: string
  loop: LoopState
}

export type JobSpec = CaptureJobSpec | VerifyJobSpec | GenerateJobSpec
export type Emit = (event: WorkerEvent) => void

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

/** Recursive artifact size, used for per-tenant storage accounting. */
export async function directorySize(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else {
        const info = await stat(full).catch(() => null)
        if (info) total += info.size
      }
    }
  }
  await walk(dir)
  return total
}

export async function runCaptureJob(spec: CaptureJobSpec, emit: Emit): Promise<void> {
  const started = Date.now()
  const onProgress = (message: string) => emit({ type: 'progress', message })
  await mkdir(spec.snapshotDir, { recursive: true })

  if (spec.input.type === 'url') {
    await captureSite(spec.input.source, spec.snapshotDir, { ...spec.options, onProgress })
  } else if (spec.input.type === 'image') {
    onProgress(`image capture: ${spec.input.source}`)
    await captureImage(spec.input.source, spec.snapshotDir)
  } else {
    onProgress(`video capture: ${spec.input.source}`)
    await captureVideo(spec.input.source, spec.snapshotDir)
  }

  emit({ type: 'task-result', result: await summarizeSnapshot(spec.snapshotDir, Date.now() - started) })
}

/**
 * Build + probe the repro, pixel/DOM diff with dynamic masking, report and
 * convergence decision. Returns the result plus the advanced loop state.
 */
export async function executeVerification(
  spec: VerifyJobSpec,
  emit: Emit,
): Promise<{ result: VerificationResult; loop: LoopState }> {
  const started = Date.now()
  const onProgress = (message: string) => emit({ type: 'progress', message })
  await mkdir(spec.verificationDir, { recursive: true })

  await captureRepro(spec.reproDir, spec.snapshotDir, {
    viewports: spec.viewports,
    maxNodes: spec.maxNodes ?? 12_000,
    allowBuild: spec.allowBuild,
    onProgress,
  })

  const diffsDir = path.join(spec.verificationDir, 'diffs', `r${spec.round}`)
  onProgress(`diffing (round ${spec.round})`)
  const diff = await diffSnapshots(spec.origDir, spec.snapshotDir, diffsDir, { round: spec.round })

  const origShots = spec.viewports.map((w) => `../../orig/screenshots/${w}.png`)
  const reproShots = spec.viewports.map((w) => `repro-snap/screenshots/${w}.png`)
  const reportPath = await writeReport(spec.verificationDir, diff, origShots, reproShots)

  const decision = decide(spec.loop, diff.metrics)
  const loop: LoopState = {
    round: spec.round,
    history: [...spec.loop.history, diff.metrics],
    escalated: spec.loop.escalated || decision === 'escalate',
  }

  const hasVlm = await stat(path.join(diffsDir, 'vlm-requests.json'))
    .then(() => true)
    .catch(() => false)

  onProgress(
    `done: ssim ${diff.metrics.ssim} · pixelDiff ${diff.metrics.pixelDiffPct}%` +
      (diff.metrics.dynamicAreaPct !== undefined ? ` · dynamic ${diff.metrics.dynamicAreaPct}%` : '') +
      ` · ${decision}`,
  )

  return {
    loop,
    result: {
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
      report: path.relative(spec.verificationDir, reportPath),
      heatmaps: spec.viewports.map((w) => `diffs/r${spec.round}/heatmap-${w}.png`),
      ...(hasVlm ? { vlmRequests: `diffs/r${spec.round}/vlm-requests.json` } : {}),
      durationMs: Date.now() - started,
    },
  }
}

export async function runVerifyJob(spec: VerifyJobSpec, emit: Emit): Promise<void> {
  const { result, loop } = await executeVerification(spec, emit)
  emit({ type: 'loop', loop })
  emit({ type: 'verification-result', result })
}

export async function runGenerateJob(spec: GenerateJobSpec, emit: Emit): Promise<void> {
  let loop = spec.loop
  const result = await runGenerationLoop({
    repoRoot: spec.repoRoot,
    origDir: spec.origDir,
    reproDir: spec.reproDir,
    viewports: spec.viewports,
    sessionId: spec.sessionId,
    skillPath: path.join(spec.repoRoot, 'skill'),
    ...(spec.agent.command ? { command: spec.agent.command } : {}),
    ...(spec.agent.args ? { commandArgs: spec.agent.args } : {}),
    ...(spec.agent.model ? { model: spec.agent.model } : {}),
    ...(spec.agent.maxRounds ? { maxRounds: spec.agent.maxRounds } : {}),
    ...(spec.agent.timeoutMs ? { timeoutMs: spec.agent.timeoutMs } : {}),
    onProgress: (message) => emit({ type: 'progress', message }),
    verify: async (round) => {
      const id = randomUUID()
      const verificationDir = path.join(spec.verificationBaseDir, id)
      const repro = { type: 'path' as const, source: spec.reproDir }
      emit({
        type: 'verification',
        id,
        round,
        status: 'running',
        reproDir: spec.reproDir,
        repro,
      })
      try {
        const { result: verified, loop: nextLoop } = await executeVerification(
          {
            kind: 'verify',
            taskId: spec.taskId,
            verificationId: id,
            origDir: spec.origDir,
            reproDir: spec.reproDir,
            snapshotDir: path.join(verificationDir, 'repro-snap'),
            verificationDir,
            round,
            viewports: spec.viewports,
            allowBuild: spec.allowBuild,
            loop,
          },
          emit,
        )
        loop = nextLoop
        emit({
          type: 'verification',
          id,
          round,
          status: 'done',
          reproDir: spec.reproDir,
          repro,
          result: verified,
        })
        emit({ type: 'loop', loop })
        return {
          metrics: verified.metrics,
          decision: verified.decision,
          topEntries: verified.topEntries,
        }
      } catch (err) {
        const message = err instanceof Error ? `${err.message}` : String(err)
        emit({
          type: 'verification',
          id,
          round,
          status: 'failed',
          reproDir: spec.reproDir,
          repro,
          error: message,
        })
        throw new Error(`round ${round} verification failed: ${message}`)
      }
    },
  })
  emit({ type: 'generation-result', finalDecision: result.finalDecision, rounds: result.rounds })
}
