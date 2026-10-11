import type { Decision } from '@copypage/diff'

export type { Decision }

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed'
export type TaskInputType = 'url' | 'image' | 'video'

export interface TaskInput {
  type: TaskInputType
  source: string
}

export interface TaskProgressEntry {
  at: string
  message: string
}

/** capture options forwarded to captureSite / captureImage / captureVideo */
export interface CaptureJobOptions {
  viewports?: number[]
  maxNodes?: number
  states?: boolean
  dynamic?: boolean
  dynamicDurationMs?: number
  assetsBudgetMs?: number
}

export interface TaskResult {
  snapshotDir: string
  title?: string
  viewports: number[]
  screenshots: Record<string, string>
  assetsOk: number
  assetsFailed: number
  dynamicRegions: number
  dismissed: number
  domNodes?: number
  durationMs: number
}

export interface Task {
  id: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  input: TaskInput
  options: CaptureJobOptions
  progress: TaskProgressEntry[]
  /** convergence loop state (mirrors diff's LoopState) */
  loop: LoopState
  verifications: Verification[]
  error?: string
  result?: TaskResult
}

export interface LoopState {
  round: number
  history: { ssim: number; pixelDiffPct: number }[]
  escalated: boolean
}

export type VerificationStatus = 'queued' | 'running' | 'done' | 'failed'

export interface Verification {
  id: string
  round: number
  status: VerificationStatus
  createdAt: string
  updatedAt: string
  repro: { type: 'path' | 'zip'; source: string }
  /** directory the repro was built/captured from (path jobs: the source itself) */
  reproDir: string
  progress: TaskProgressEntry[]
  error?: string
  result?: VerificationResult
}

export interface VerificationEntry {
  severity: number
  element: string
  property: string
  expected: string
  actual: string
}

export interface VerificationResult {
  metrics: { ssim: number; pixelDiffPct: number; dynamicAreaPct?: number }
  decision: Decision
  entries: number
  topEntries: VerificationEntry[]
  /** paths relative to the verification dir (report.html lives there too) */
  report: string
  heatmaps: string[]
  vlmRequests?: string
  durationMs: number
}
