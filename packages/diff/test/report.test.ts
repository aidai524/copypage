import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeReport } from '../src/report.js'

describe('writeReport', () => {
  let dir: string
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('writes html with metrics, entries and comparison slider', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-report-'))
    const htmlPath = await writeReport(
      dir,
      {
        metrics: { ssim: 0.962, pixelDiffPct: 3.1 },
        entries: [
          {
            id: 'd-001', element: 'button.cta', property: 'boxShadow',
            expected: '0 4px 14px rgba(99,102,241,0.4)', actual: 'none', severity: 8.2,
            component: 'src/components/PricingCard.tsx',
          },
        ],
      },
      ['../orig/screenshots/800.png'],
      ['../repro/screenshots/800.png'],
    )
    const html = await readFile(htmlPath, 'utf8')
    expect(html).toContain('0.962')
    expect(html).toContain('button.cta')
    expect(html).toContain('boxShadow')
    expect(html).toContain('PricingCard.tsx')
    expect(html).toContain('slider')
    expect(html).toContain('../orig/screenshots/800.png')
  })
})
