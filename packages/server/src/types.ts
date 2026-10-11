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
  error?: string
  result?: TaskResult
}
