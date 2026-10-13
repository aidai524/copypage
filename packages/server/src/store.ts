import { EventEmitter } from 'node:events'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Db, TaskRow } from './db.js'
import type {
  CaptureJobOptions,
  Generation,
  Task,
  TaskInput,
  TaskStatus,
  Verification,
} from './types.js'

/**
 * One-time import of task.json files written by the pre-SQLite file store.
 * Idempotent: existing ids are skipped. Legacy tasks belong to the operator
 * (`system`) so single-user deployments keep their history after upgrading.
 */
export async function importLegacyTasks(dataDir: string, db: Db): Promise<number> {
  const tasksRoot = path.join(dataDir, 'tasks')
  const entries = await readdir(tasksRoot, { withFileTypes: true }).catch(() => [])
  let imported = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (db.getTask(entry.name)) continue
    const file = path.join(tasksRoot, entry.name, 'task.json')
    const legacy = await readFile(file, 'utf8')
      .then((raw) => JSON.parse(raw) as Partial<Task>)
      .catch(() => null)
    if (!legacy?.id || !legacy.input) continue
    const now = new Date().toISOString()
    db.insertTask({
      id: legacy.id,
      owner_id: legacy.ownerId ?? 'system',
      status: legacy.status ?? 'done',
      input_json: JSON.stringify(legacy.input),
      options_json: JSON.stringify(legacy.options ?? {}),
      progress_json: JSON.stringify(legacy.progress ?? []),
      loop_json: JSON.stringify(legacy.loop ?? { round: 0, history: [], escalated: false }),
      verifications_json: JSON.stringify(legacy.verifications ?? []),
      generations_json: JSON.stringify(legacy.generations ?? []),
      result_json: legacy.result ? JSON.stringify(legacy.result) : null,
      worker_json: '{}',
      size_bytes: legacy.sizeBytes ?? 0,
      error: legacy.error ?? null,
      created_at: legacy.createdAt ?? now,
      updated_at: legacy.updatedAt ?? now,
    })
    imported++
  }
  return imported
}

export function newTaskId(): string {
  const t = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

const MAX_PROGRESS_ENTRIES = 500

function pushProgress(list: { at: string; message: string }[], message: string): void {
  list.push({ at: new Date().toISOString(), message })
  if (list.length > MAX_PROGRESS_ENTRIES) {
    list.splice(0, list.length - MAX_PROGRESS_ENTRIES)
  }
}

/**
 * Task repository: SQLite is the source of truth (owner-scoped, survives
 * restarts, visible to worker processes), artifacts live under dataDir.
 * Emits 'task' on every change so the SSE endpoint can stream updates.
 */
export class TaskStore {
  readonly events = new EventEmitter()

  constructor(
    readonly dataDir: string,
    private db: Db,
  ) {
    this.events.setMaxListeners(0)
  }

  taskDir(id: string): string {
    return path.join(this.dataDir, 'tasks', id)
  }

  snapshotDir(id: string): string {
    return path.join(this.taskDir(id), 'orig')
  }

  verificationDir(taskId: string, verificationId: string): string {
    return path.join(this.taskDir(taskId), 'verifications', verificationId)
  }

  generationDir(taskId: string, generationId: string): string {
    return path.join(this.taskDir(taskId), 'generations', generationId)
  }

  private toTask(row: TaskRow): Task {
    return {
      id: row.id,
      ownerId: row.owner_id,
      status: row.status as TaskStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      input: JSON.parse(row.input_json) as TaskInput,
      options: JSON.parse(row.options_json) as CaptureJobOptions,
      progress: JSON.parse(row.progress_json) as Task['progress'],
      loop: JSON.parse(row.loop_json) as Task['loop'],
      verifications: JSON.parse(row.verifications_json) as Verification[],
      generations: JSON.parse(row.generations_json) as Generation[],
      ...(row.result_json ? { result: JSON.parse(row.result_json) as Task['result'] } : {}),
      ...(row.error ? { error: row.error } : {}),
      sizeBytes: Number(row.size_bytes),
      ...(row.worker_json && row.worker_json !== '{}'
        ? { worker: JSON.parse(row.worker_json) as Task['worker'] }
        : {}),
    }
  }

  private persist(task: Task): void {
    this.db.updateTask(task.id, {
      status: task.status,
      progress_json: JSON.stringify(task.progress),
      loop_json: JSON.stringify(task.loop),
      verifications_json: JSON.stringify(task.verifications),
      generations_json: JSON.stringify(task.generations),
      result_json: task.result ? JSON.stringify(task.result) : null,
      worker_json: JSON.stringify(task.worker ?? {}),
      size_bytes: task.sizeBytes ?? 0,
      error: task.error ?? null,
      updated_at: task.updatedAt,
    })
  }

  get(id: string): Task | undefined {
    const row = this.db.getTask(id)
    return row ? this.toTask(row) : undefined
  }

  list(ownerId?: string, limit = 500): Task[] {
    return this.db.listTasks(ownerId, limit).map((row) => this.toTask(row))
  }

  count(ownerId?: string): number {
    return this.db.countTasks(ownerId)
  }

  async create(ownerId: string, input: TaskInput, options: CaptureJobOptions = {}): Promise<Task> {
    const now = new Date().toISOString()
    const task: Task = {
      id: newTaskId(),
      ownerId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      input,
      options,
      progress: [],
      loop: { round: 0, history: [], escalated: false },
      verifications: [],
      generations: [],
      sizeBytes: 0,
    }
    await mkdir(this.taskDir(task.id), { recursive: true })
    this.db.insertTask({
      id: task.id,
      owner_id: task.ownerId,
      status: task.status,
      input_json: JSON.stringify(task.input),
      options_json: JSON.stringify(task.options),
      progress_json: JSON.stringify(task.progress),
      loop_json: JSON.stringify(task.loop),
      verifications_json: JSON.stringify(task.verifications),
      generations_json: JSON.stringify(task.generations),
      result_json: null,
      worker_json: '{}',
      size_bytes: 0,
      error: null,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    })
    this.emit(task)
    return task
  }

  async update(id: string, patch: Partial<Task>): Promise<Task> {
    const task = this.get(id)
    if (!task) throw new Error(`unknown task ${id}`)
    Object.assign(task, patch, { updatedAt: new Date().toISOString() })
    this.persist(task)
    this.emit(task)
    return task
  }

  async appendProgress(id: string, message: string): Promise<void> {
    const task = this.get(id)
    if (!task) return
    pushProgress(task.progress, message)
    task.updatedAt = new Date().toISOString()
    this.persist(task)
    this.emit(task)
  }

  async setSize(id: string, sizeBytes: number): Promise<void> {
    const task = this.get(id)
    if (!task) return
    task.sizeBytes = sizeBytes
    task.updatedAt = new Date().toISOString()
    this.persist(task)
    this.emit(task)
  }

  async createVerification(
    taskId: string,
    repro: Verification['repro'],
    reproDir: string,
    opts: { id?: string; round?: number } = {},
  ): Promise<Verification> {
    const task = this.get(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    const now = new Date().toISOString()
    const verification: Verification = {
      id: opts.id ?? newTaskId(),
      round: opts.round ?? task.loop.round + 1,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      repro,
      reproDir,
      progress: [],
    }
    await mkdir(this.verificationDir(taskId, verification.id), { recursive: true })
    task.verifications.push(verification)
    task.updatedAt = now
    this.persist(task)
    this.emit(task)
    return verification
  }

  async updateVerification(
    taskId: string,
    verificationId: string,
    patch: Partial<Verification>,
  ): Promise<Verification> {
    const task = this.get(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    const verification = task.verifications.find((v) => v.id === verificationId)
    if (!verification) throw new Error(`unknown verification ${verificationId}`)
    Object.assign(verification, patch, { updatedAt: new Date().toISOString() })
    task.updatedAt = verification.updatedAt
    this.persist(task)
    this.emit(task)
    return verification
  }

  async appendVerificationProgress(
    taskId: string,
    verificationId: string,
    message: string,
  ): Promise<void> {
    const task = this.get(taskId)
    const verification = task?.verifications.find((v) => v.id === verificationId)
    if (!task || !verification) return
    pushProgress(verification.progress, message)
    verification.updatedAt = new Date().toISOString()
    task.updatedAt = verification.updatedAt
    this.persist(task)
    this.emit(task)
  }

  async createGeneration(
    taskId: string,
    opts: { reproDir: string; sessionId: string; command: string; model?: string },
  ): Promise<Generation> {
    const task = this.get(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    const now = new Date().toISOString()
    const generation: Generation = {
      id: newTaskId(),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      reproDir: opts.reproDir,
      sessionId: opts.sessionId,
      agent: { command: opts.command, ...(opts.model ? { model: opts.model } : {}) },
      rounds: [],
      progress: [],
    }
    await mkdir(this.generationDir(taskId, generation.id), { recursive: true })
    task.generations.push(generation)
    task.updatedAt = now
    this.persist(task)
    this.emit(task)
    return generation
  }

  async updateGeneration(
    taskId: string,
    generationId: string,
    patch: Partial<Generation>,
  ): Promise<Generation> {
    const task = this.get(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    const generation = task.generations.find((g) => g.id === generationId)
    if (!generation) throw new Error(`unknown generation ${generationId}`)
    Object.assign(generation, patch, { updatedAt: new Date().toISOString() })
    task.updatedAt = generation.updatedAt
    this.persist(task)
    this.emit(task)
    return generation
  }

  async appendGenerationProgress(
    taskId: string,
    generationId: string,
    message: string,
  ): Promise<void> {
    const task = this.get(taskId)
    const generation = task?.generations.find((g) => g.id === generationId)
    if (!task || !generation) return
    pushProgress(generation.progress, message)
    generation.updatedAt = new Date().toISOString()
    task.updatedAt = generation.updatedAt
    this.persist(task)
    this.emit(task)
  }

  /** delete a task: artifacts on disk + database row */
  async delete(id: string): Promise<boolean> {
    const task = this.get(id)
    if (!task) return false
    await rm(this.taskDir(id), { recursive: true, force: true }).catch(() => {})
    const removed = this.db.deleteTask(id)
    if (removed) this.events.emit('cleaned', [id])
    return removed
  }

  /** retention sweep: delete finished tasks older than maxAgeMs */
  async cleanupOlderThan(maxAgeMs: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    const ids = this.db.expiredTaskIds(cutoff)
    const removed: string[] = []
    for (const id of ids) {
      await rm(this.taskDir(id), { recursive: true, force: true }).catch(() => {})
      if (this.db.deleteTask(id)) removed.push(id)
    }
    if (removed.length > 0) this.events.emit('cleaned', removed)
    return removed
  }

  private emit(task: Task): void {
    this.events.emit('task', task)
  }
}
