import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { writeFileSync } from 'node:fs'
import { pixelDiff } from '../src/pixel.js'

function solidPng(w: number, h: number, rgba: [number, number, number, number], file: string, blackRightHalf = false) {
  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [r, g, b, a] = blackRightHalf && x >= w / 2 ? [0, 0, 0, 255] : rgba
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a
    }
  }
  writeFileSync(file, PNG.sync.write(png))
}

describe('pixelDiff', () => {
  let dir: string
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('measures ~50% diff and <1 ssim for half-changed image', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-pixel-'))
    const a = path.join(dir, 'a.png')
    const b = path.join(dir, 'b.png')
    solidPng(200, 100, [255, 255, 255, 255], a)
    solidPng(200, 100, [255, 255, 255, 255], b, true)
    const heat = path.join(dir, 'heat.png')

    const res = await pixelDiff(a, b, heat)
    if ('layoutError' in res) throw new Error('unexpected layoutError')
    expect(res.pixelDiffPct).toBeGreaterThan(45)
    expect(res.pixelDiffPct).toBeLessThan(55)
    expect(res.ssim).toBeLessThan(1)

    await access(heat)
  })

  it('identical images → ssim 1, diff 0', async () => {
    const a = path.join(dir, 'c.png')
    const b = path.join(dir, 'd.png')
    solidPng(64, 64, [10, 20, 30, 255], a)
    solidPng(64, 64, [10, 20, 30, 255], b)
    const res = await pixelDiff(a, b, path.join(dir, 'h2.png'))
    if ('layoutError' in res) throw new Error('unexpected')
    expect(res.ssim).toBeGreaterThan(0.999)
    expect(res.pixelDiffPct).toBe(0)
  })

  it('size mismatch → layoutError', async () => {
    const a = path.join(dir, 'e.png')
    const b = path.join(dir, 'f.png')
    solidPng(100, 100, [255, 255, 255, 255], a)
    solidPng(120, 100, [255, 255, 255, 255], b)
    const res = await pixelDiff(a, b, path.join(dir, 'h3.png'))
    expect(res).toEqual({ layoutError: true })
  })
})
