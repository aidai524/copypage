import { EventEmitter } from 'node:events'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CaptureJobOptions, Task, TaskInput } from './types.js'

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

  constructor(readonly dataDir: string) {
    this.events.setMaxListeners(0)
  }

  taskDir(id: string): string {
    return path.join(this.dataDir, 'tasks', id)
  }

  snapshotDir(id: string): string {
    return path.join(this.taskDir(id), 'orig')
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
        if (task.status === 'running' || task.status === 'queued') {
          task.status = 'failed'
          task.error = 'server restarted while the capture was pending'
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

  private async persist(task: Task): Promise<void> {
    const dir = this.taskDir(task.id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, 'task.json')
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(task, null, 2))
    await rename(tmp, file)
  }

  private emit(task: Task): void {
    this.events.emit('task', task)
  }
}
