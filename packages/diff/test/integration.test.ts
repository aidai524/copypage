import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveStatic, type StaticServer } from '@copypage/core'
import { captureSite } from '@copypage/capture'
import { diffSnapshots } from '../src/index.js'

const SITE = path.resolve(__dirname, '../../../fixtures/site')
const MUTATED = path.resolve(__dirname, '../../../fixtures/site-mutated')

describe('diffSnapshots (self-referential)', () => {
  let dir: string
  let s1: StaticServer
  let s2: StaticServer
  let result: Awaited<ReturnType<typeof diffSnapshots>>

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-int-'))
    s1 = await serveStatic(SITE)
    s2 = await serveStatic(MUTATED)
    await captureSite(s1.url, path.join(dir, 'orig'), { viewports: [800] })
    await captureSite(s2.url, path.join(dir, 'repro'), { viewports: [800] })
    result = await diffSnapshots(path.join(dir, 'orig'), path.join(dir, 'repro'), path.join(dir, 'diff'))
  }, 180000)

  afterAll(async () => {
    await s1.close()
    await s2.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('reports the exact mutated border-radius', () => {
    const e = result.entries.find(
      (x) => x.property === 'borderRadius' && x.element.includes('cta'),
    )
    expect(e).toBeDefined()
    expect(e!.expected).toBe('12px')
    expect(e!.actual).toBe('8px')
  })

  it('reports the removed box-shadow', () => {
    const e = result.entries.find(
      (x) => x.property === 'boxShadow' && x.element.includes('cta'),
    )
    expect(e).toBeDefined()
    expect(e!.actual).toBe('none')
    expect(e!.expected).toContain('rgba(99, 102, 241')
  })

  it('pixel metrics register the difference', () => {
    expect(result.metrics.pixelDiffPct).toBeGreaterThan(0)
    expect(result.metrics.ssim).toBeLessThan(1)
  })

  it('writes diff.json with sorted entries', async () => {
    const raw = JSON.parse(await readFile(path.join(dir, 'diff', 'diff.json'), 'utf8'))
    expect(raw.metrics.ssim).toBeDefined()
    const sevs = raw.entries.map((e: { severity: number }) => e.severity)
    expect([...sevs].sort((a, b) => b - a)).toEqual(sevs)
  })
})

describe('diffSnapshots fallback to VLM queue', () => {
  it('produces vlm-requests.json when DOM is absent', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cp-vlm-'))
    try {
      // image-type snapshots: screenshots only, no dom/
      const { writeSnapshot } = await import('@copypage/core')
      const { writeFile: wf, mkdir: md } = await import('node:fs/promises')
      const { PNG } = await import('pngjs')
      const mk = async (d: string, rightHalfBlack: boolean) => {
        await md(path.join(d, 'screenshots'), { recursive: true })
        const png = new PNG({ width: 200, height: 100 })
        for (let y = 0; y < 100; y++)
          for (let x = 0; x < 200; x++) {
            const i = (y * 200 + x) * 4
            const v = rightHalfBlack && x >= 100 ? 0 : 255
            png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255
          }
        await wf(path.join(d, 'screenshots', '800.png'), PNG.sync.write(png))
        await writeSnapshot(d, {
          input: { type: 'image', source: 'x.png' },
          viewports: [800],
          screenshots: { '800': 'screenshots/800.png' },
        })
      }
      await mk(path.join(dir, 'orig'), false)
      await mk(path.join(dir, 'repro'), true)

      await diffSnapshots(path.join(dir, 'orig'), path.join(dir, 'repro'), path.join(dir, 'out'))
      const vlmRaw = JSON.parse(await readFile(path.join(dir, 'out', 'vlm-requests.json'), 'utf8'))
      expect(vlmRaw.requests.length).toBeGreaterThan(0)
      await access(path.join(dir, 'out', vlmRaw.requests[0].crop))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60000)
})
