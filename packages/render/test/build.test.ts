import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, readFile, access, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureRepro } from '../src/index.js'

const VITE_FIXTURE = path.resolve(__dirname, 'fixtures/repro-vite')

describe('captureRepro builds vite-style projects', () => {
  let dir: string
  let reproDir: string

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('runs build when dist/index.html is missing (even though root index.html exists) and serves dist', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-render-vite-'))
    reproDir = path.join(dir, 'repro')
    await cp(VITE_FIXTURE, reproDir, { recursive: true })

    const out = path.join(dir, 'snap')
    await captureRepro(reproDir, out, { viewports: [800] })

    // build ran → dist exists
    await access(path.join(reproDir, 'dist', 'index.html'))
    // served dist, not root source
    const meta = JSON.parse(await readFile(path.join(out, 'meta.json'), 'utf8'))
    expect(meta.title).toBe('FROM-DIST')
  }, 120000)
})
