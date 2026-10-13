import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteDb as Db } from '../src/db.js'
import { TaskStore } from '../src/store.js'

describe('TaskStore', () => {
  let dir: string
  let db: Db
  let store: TaskStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-store-'))
    db = new Db(dir)
    store = new TaskStore(dir, db)
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('creates, updates and persists owner-scoped tasks', async () => {
    const task = await store.create('u1', { type: 'url', source: 'https://example.com' }, { viewports: [800] })
    expect(task.status).toBe('queued')
    expect(task.ownerId).toBe('u1')
    expect(task.options.viewports).toEqual([800])

    await store.update(task.id, { status: 'running' })
    await store.appendProgress(task.id, 'viewport 800: loading')

    // no in-memory cache: a fresh store over the same database sees everything
    const db2 = new Db(dir)
    const store2 = new TaskStore(dir, db2)
    expect((await store2.get(task.id))!.status).toBe('running')
    expect((await store2.get(task.id))!.progress[0].message).toBe('viewport 800: loading')
    expect(await store2.list('u1')).toHaveLength(1)
    expect(await store2.list('u2')).toHaveLength(0)
    expect(await store2.count('u1')).toBe(1)
    db2.close()
  })

  it('tracks verification and generation records', async () => {
    const task = await store.create('u1', { type: 'url', source: 'https://example.com' })
    const verification = await store.createVerification(
      task.id,
      { type: 'path', source: '/tmp/x' },
      '/tmp/x',
    )
    expect(verification.round).toBe(1)
    await store.updateVerification(task.id, verification.id, { status: 'done' })

    const generation = await store.createGeneration(task.id, {
      reproDir: '/tmp/g',
      sessionId: 's1',
      command: 'pi',
    })
    expect(generation.status).toBe('queued')
    await store.updateGeneration(task.id, generation.id, { status: 'done', finalDecision: 'pass' })

    const reloaded = (await store.get(task.id))!
    expect(reloaded.verifications).toHaveLength(1)
    expect(reloaded.verifications[0].status).toBe('done')
    expect(reloaded.generations[0].finalDecision).toBe('pass')
  })

  it('emits task events for subscribers', async () => {
    const seen: string[] = []
    store.events.on('task', (t: { status: string }) => seen.push(t.status))
    const task = await store.create('u1', { type: 'url', source: 'https://example.com' })
    await store.update(task.id, { status: 'done' })
    expect(seen).toEqual(['queued', 'done'])
  })

  it('deletes tasks and sweeps expired ones', async () => {
    const task = await store.create('u1', { type: 'url', source: 'https://example.com' })
    await store.delete(task.id)
    expect(await store.get(task.id)).toBeUndefined()

    const old = await store.create('u1', { type: 'url', source: 'https://example.com' })
    await store.update(old.id, { status: 'done' })
    await db.updateTask(old.id, { updated_at: new Date(Date.now() - 10_000).toISOString() })
    const removed = await store.cleanupOlderThan(500)
    expect(removed).toContain(old.id)
    expect(await store.get(old.id)).toBeUndefined()
  })

  it('rejects unknown task ids on update', async () => {
    await expect(store.update('nope', { status: 'done' })).rejects.toThrow('unknown task')
  })
})
