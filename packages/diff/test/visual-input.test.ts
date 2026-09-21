import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { writeSnapshot } from '@copypage/core'
import { diffSnapshots } from '../src/index.js'

function solidPng(w: number, h: number, v: number, file: string) {
  const png = new PNG({ width: w, height: h })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255
  }
  return writeFile(file, PNG.sync.write(png))
}

describe('visual-input diff (I5)', () => {
  let dir: string
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('image orig vs url repro produces vlm-requests instead of dead-ending', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-vis-'))
    // orig: image snapshot 200x100
    const orig = path.join(dir, 'orig')
    await mkdir(path.join(orig, 'screenshots'), { recursive: true })
    await solidPng(200, 100, 255, path.join(orig, 'original.png'))
    await writeSnapshot(orig, {
      input: { type: 'image', source: 'in.png' },
      viewports: [200],
      screenshots: { original: 'original.png' },
    })
    // repro: url snapshot at 800 (different size)
    const repro = path.join(dir, 'repro')
    await mkdir(path.join(repro, 'screenshots'), { recursive: true })
    await solidPng(800, 600, 200, path.join(repro, 'screenshots', '800.png'))
    await writeSnapshot(repro, {
      input: { type: 'url', source: 'http://x' },
      viewports: [800],
      screenshots: { '800': 'screenshots/800.png' },
    })

    const out = path.join(dir, 'out')
    const result = await diffSnapshots(orig, repro, out)

    // must not silently pass with zero work
    expect(result.metrics.pixelDiffPct).toBeGreaterThan(0)
    const vlmRaw = JSON.parse(await readFile(path.join(out, 'vlm-requests.json'), 'utf8'))
    expect(vlmRaw.requests.length).toBeGreaterThan(0)
    await access(path.join(out, vlmRaw.requests[0].crop))
    await access(path.join(out, vlmRaw.requests[0].reproCrop))
  })

  it('layoutError contributes worst-case metrics (I1)', async () => {
    const dir2 = await mkdtemp(path.join(tmpdir(), 'cp-layout-'))
    try {
      const orig = path.join(dir2, 'orig')
      await mkdir(path.join(orig, 'screenshots'), { recursive: true })
      await solidPng(200, 100, 255, path.join(orig, 'screenshots', '800.png'))
      await writeSnapshot(orig, {
        input: { type: 'url', source: 'http://a' },
        viewports: [800],
        screenshots: { '800': 'screenshots/800.png' },
      })
      const repro = path.join(dir2, 'repro')
      await mkdir(path.join(repro, 'screenshots'), { recursive: true })
      await solidPng(300, 100, 255, path.join(repro, 'screenshots', '800.png'))
      await writeSnapshot(repro, {
        input: { type: 'url', source: 'http://b' },
        viewports: [800],
        screenshots: { '800': 'screenshots/800.png' },
      })

      const result = await diffSnapshots(orig, repro, path.join(dir2, 'out'))
      expect(result.metrics.pixelDiffPct).toBe(100)
      expect(result.metrics.ssim).toBe(0)
      expect(result.entries.some((e) => e.property === 'layout')).toBe(true)
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  })
})
