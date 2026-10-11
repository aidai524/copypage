import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { pixelDiff } from '../src/pixel.js'

function makePng(w: number, h: number, fill: (x: number, y: number) => [number, number, number]): PNG {
  const png = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const [r, g, b] = fill(x, y)
      png.data[i] = r
      png.data[i + 1] = g
      png.data[i + 2] = b
      png.data[i + 3] = 255
    }
  }
  return png
}

describe('pixelDiff masks', () => {
  let dir: string
  const W = 200
  const H = 100

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-mask-'))
    const a = makePng(W, H, () => [255, 255, 255])
    const b = makePng(W, H, (x) => (x < W / 2 ? [255, 255, 255] : [0, 0, 0]))
    await import('node:fs/promises').then(({ writeFile }) =>
      Promise.all([
        writeFile(path.join(dir, 'a.png'), PNG.sync.write(a)),
        writeFile(path.join(dir, 'b.png'), PNG.sync.write(b)),
      ]),
    )
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the raw diff without masks', async () => {
    const res = await pixelDiff(path.join(dir, 'a.png'), path.join(dir, 'b.png'), path.join(dir, 'raw.png'))
    expect('layoutError' in res).toBe(false)
    if ('layoutError' in res) return
    expect(res.pixelDiffPct).toBeGreaterThan(40)
    expect(res.dynamicAreaPct).toBeUndefined()
  })

  it('excludes masked regions from metrics and tints the heatmap', async () => {
    const res = await pixelDiff(
      path.join(dir, 'a.png'),
      path.join(dir, 'b.png'),
      path.join(dir, 'masked.png'),
      { masks: [{ x: 100, y: 0, width: 100, height: 100 }] },
    )
    expect('layoutError' in res).toBe(false)
    if ('layoutError' in res) return
    expect(res.pixelDiffPct).toBeLessThan(1)
    expect(res.dynamicAreaPct).toBeCloseTo(50, 0)
    await access(path.join(dir, 'masked.png'))
    const heat = PNG.sync.read(await import('node:fs/promises').then(({ readFile }) => readFile(path.join(dir, 'masked.png'))))
    const i = (50 * heat.width + 150) * 4
    // blue tint on the masked half
    expect(heat.data[i + 2]).toBeGreaterThan(heat.data[i])
  })
})
