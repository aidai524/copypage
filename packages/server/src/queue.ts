import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { readSnapshot } from '@copypage/core'
import { captureImage, captureSite, captureVideo } from '@copypage/capture'
import type { TaskStore } from './store.js'
import type { TaskResult } from './types.js'

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
 * Serial capture queue: browser captures are memory/time heavy, so jobs run
 * one at a time in FIFO order. Progress strings stream back through the store.
 */
export class CaptureQueue {
  private pending: string[] = []
  private running = false

  constructor(private store: TaskStore) {}

  /** queued + running jobs */
  get size(): number {
    return this.pending.length + (this.running ? 1 : 0)
  }

  enqueue(id: string): void {
    this.pending.push(id)
    void this.pump()
  }

  private async pump(): Promise<void> {
    if (this.running) return
    const id = this.pending.shift()
    if (!id) return
    this.running = true
    try {
      await this.run(id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.store.appendProgress(id, `failed: ${message}`)
      await this.store.update(id, { status: 'failed', error: message })
    } finally {
      this.running = false
      void this.pump()
    }
  }

  private async run(id: string): Promise<void> {
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
}
