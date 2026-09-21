import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSnapshot } from '@copypage/core'
import { captureRepro, BuildError } from '../src/index.js'

const REPRO_DIST = path.resolve(__dirname, 'fixtures/repro-dist')

describe('captureRepro', () => {
  let dir: string

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('serves an existing dist and captures it', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-render-'))
    // reproDir itself is the dist (no package.json → no build attempted)
    const out = path.join(dir, 'repro-snapshot')
    await captureRepro(REPRO_DIST, out, { viewports: [800] })
    const snap = await readSnapshot(out)
    expect(snap.input.type).toBe('url')
    expect(snap.screenshots['800']).toBeDefined()
  }, 120000)

  it('throws BuildError with output when build fails', async () => {
    const badDir = await mkdtemp(path.join(tmpdir(), 'cp-render-bad-'))
    try {
      // package.json with failing build script
      await import('node:fs/promises').then((fs) =>
        fs.writeFile(
          path.join(badDir, 'package.json'),
          JSON.stringify({ scripts: { build: 'exit 1 && echo boom-build-failed' } }),
        ),
      )
      await expect(captureRepro(badDir, path.join(dir, 'x'))).rejects.toThrow(BuildError)
    } finally {
      await rm(badDir, { recursive: true, force: true })
    }
  }, 60000)
})
