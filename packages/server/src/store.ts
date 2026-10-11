import { EventEmitter } from 'node:events'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CaptureJobOptions, Task, TaskInput, Verification } from './types.js'

export function newTaskId(): string {
  const t = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

const MAX_PROGRESS_ENTRIES = 500

/**
 * Task registry with disk write-through. Emits 'task' with the full Task on
 * every change so the SSE endpoint can stream updates.
 */
export class TaskStore {
  readonly events = new EventEmitter()
  private tasks = new Map<string, Task>()
  /** serializes task.json writes per task id (progress + status updates race otherwise) */
  private persistChains = new Map<string, Promise<void>>()

  constructor(readonly dataDir: string) {
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

  /** Load persisted tasks; running jobs from a previous process are marked failed. */
  async init(): Promise<void> {
    const tasksRoot = path.join(this.dataDir, 'tasks')
    await mkdir(tasksRoot, { recursive: true })
    const entries = await readdir(tasksRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const task = JSON.parse(
          await readFile(path.join(tasksRoot, entry.name, 'task.json'), 'utf8'),
        ) as Task
        // migrate tasks written before the convergence loop existed
        let changed = false
        if (!task.loop) {
          task.loop = { round: 0, history: [], escalated: false }
          changed = true
        }
        if (!Array.isArray(task.verifications)) {
          task.verifications = []
          changed = true
        }
        if (task.status === 'running' || task.status === 'queued') {
          task.status = 'failed'
          task.error = 'server restarted while the capture was pending'
          changed = true
        }
        if (changed) {
          task.updatedAt = new Date().toISOString()
          await this.persist(task)
        }
        this.tasks.set(task.id, task)
      } catch {
        // no task.json / malformed — ignore stray directories
      }
    }
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  async create(input: TaskInput, options: CaptureJobOptions = {}): Promise<Task> {
    const now = new Date().toISOString()
    const task: Task = {
      id: newTaskId(),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      input,
      options,
      progress: [],
      loop: { round: 0, history: [], escalated: false },
      verifications: [],
    }
    await mkdir(this.taskDir(task.id), { recursive: true })
    this.tasks.set(task.id, task)
    await this.persist(task)
    this.emit(task)
    return task
  }
  async update(id: string, patch: Partial<Task>): Promise<Task> {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`unknown task ${id}`)
    Object.assign(task, patch, { updatedAt: new Date().toISOString() })
    await this.persist(task)
    this.emit(task)
    return task
  }

  async appendProgress(id: string, message: string): Promise<void> {
    const task = this.tasks.get(id)
    if (!task) return
    task.progress.push({ at: new Date().toISOString(), message })
    if (task.progress.length > MAX_PROGRESS_ENTRIES) {
      task.progress.splice(0, task.progress.length - MAX_PROGRESS_ENTRIES)
    }
    task.updatedAt = new Date().toISOString()
    await this.persist(task)
    this.emit(task)
  }

  async createVerification(
    taskId: string,
    repro: Verification['repro'],
    reproDir: string,
  ): Promise<Verification> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    const now = new Date().toISOString()
    const verification: Verification = {
      id: newTaskId(),
      round: task.loop.round + 1,
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
    await this.persist(task)
    this.emit(task)
    return verification
  }

  async updateVerification(
    taskId: string,
    verificationId: string,
    patch: Partial<Verification>,
  ): Promise<Verification> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    const verification = task.verifications.find((v) => v.id === verificationId)
    if (!verification) throw new Error(`unknown verification ${verificationId}`)
    Object.assign(verification, patch, { updatedAt: new Date().toISOString() })
    task.updatedAt = verification.updatedAt
    await this.persist(task)
    this.emit(task)
    return verification
  }

  async appendVerificationProgress(
    taskId: string,
    verificationId: string,
    message: string,
  ): Promise<void> {
    const task = this.tasks.get(taskId)
    const verification = task?.verifications.find((v) => v.id === verificationId)
    if (!task || !verification) return
    verification.progress.push({ at: new Date().toISOString(), message })
    if (verification.progress.length > MAX_PROGRESS_ENTRIES) {
      verification.progress.splice(0, verification.progress.length - MAX_PROGRESS_ENTRIES)
    }
    verification.updatedAt = new Date().toISOString()
    task.updatedAt = verification.updatedAt
    await this.persist(task)
    this.emit(task)
  }

  private persist(task: Task): Promise<void> {
    const prev = this.persistChains.get(task.id) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        const dir = this.taskDir(task.id)
        await mkdir(dir, { recursive: true })
        const file = path.join(dir, 'task.json')
        // unique tmp name: two writes must never share a rename target
        const tmp = `${file}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await writeFile(tmp, JSON.stringify(task, null, 2))
        await rename(tmp, file)
      })
      .catch(() => {
        // keep the chain alive; write failures surface through the task status
      })
    this.persistChains.set(task.id, next)
    return next
  }

  private emit(task: Task): void {
    this.events.emit('task', task)
  }
}
