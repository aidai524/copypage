import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskStore } from '../src/store.js'

describe('TaskStore', () => {
  let dir: string
  let store: TaskStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-store-'))
    store = new TaskStore(dir)
    await store.init()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates, updates and persists tasks', async () => {
    const task = await store.create({ type: 'url', source: 'https://example.com' }, { viewports: [800] })
    expect(task.status).toBe('queued')
    expect(task.options.viewports).toEqual([800])

    await store.update(task.id, { status: 'running' })
    await store.appendProgress(task.id, 'viewport 800: loading')
    expect(store.get(task.id)!.status).toBe('running')
    expect(store.get(task.id)!.progress).toHaveLength(1)

    const reloaded = new TaskStore(dir)
    await reloaded.init()
    expect(reloaded.get(task.id)!.progress[0].message).toBe('viewport 800: loading')
  })

  it('marks tasks that were running during a restart as failed', async () => {
    const task = await store.create({ type: 'url', source: 'https://example.com' })
    await store.update(task.id, { status: 'running' })

    const reloaded = new TaskStore(dir)
    await reloaded.init()
    const after = reloaded.get(task.id)!
    expect(after.status).toBe('failed')
    expect(after.error).toContain('restarted')
  })

  it('emits task events for subscribers', async () => {
    const seen: string[] = []
    store.events.on('task', (t: { status: string }) => seen.push(t.status))
    const task = await store.create({ type: 'url', source: 'https://example.com' })
    await store.update(task.id, { status: 'done' })
    expect(seen).toEqual(['queued', 'done'])
  })

  it('rejects unknown task ids on update', async () => {
    await expect(store.update('nope', { status: 'done' })).rejects.toThrow('unknown task')
  })
})
