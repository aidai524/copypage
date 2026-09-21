import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeSnapshot, type DomSnapshot, type Snapshot, type SnapshotMeta } from '@copypage/core'
import { autoScroll, probeDom } from './probe.js'
import { downloadAssets } from './assets.js'
import { captureStates } from './states.js'
import { detectCharts } from './charts.js'

export interface CaptureSiteOptions {
  viewports?: number[]
  /** page height for each viewport; defaults to 900 */
  viewportHeight?: number
}

const DEFAULT_VIEWPORTS = [1440, 768, 375]

/**
 * Capture a live URL: per-viewport full-page screenshot + DOM snapshot,
 * plus page meta. Writes a snapshot/ directory consumable by diff tools.
 */
export async function captureSite(
  url: string,
  outDir: string,
  opts: CaptureSiteOptions = {},
): Promise<void> {
  const viewports = opts.viewports ?? DEFAULT_VIEWPORTS
  const height = opts.viewportHeight ?? 900
  await mkdir(path.join(outDir, 'screenshots'), { recursive: true })
  await mkdir(path.join(outDir, 'dom'), { recursive: true })

  const browser = await chromium.launch()
  let snapshotAssets: string | undefined
  let snapshotCharts: string | undefined
  try {
    const screenshots: Record<string, string> = {}
    const doms: DomSnapshot[] = []

    for (const width of viewports) {
      const page = await browser.newPage({ viewport: { width, height } })
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 })
        await autoScroll(page)
        const shotRel = `screenshots/${width}.png`
        await page.screenshot({ path: path.join(outDir, shotRel), fullPage: true })
        const root = await probeDom(page)
        const dom: DomSnapshot = {
          url: page.url(),
          viewport: { width, height },
          capturedAt: new Date().toISOString(),
          root,
        }
        await writeFile(path.join(outDir, 'dom', `${width}.json`), JSON.stringify(dom))
        doms.push(dom)
        screenshots[String(width)] = shotRel
      } finally {
        await page.close()
      }
    }

    // meta from the first (desktop) viewport
    const page = await browser.newPage({ viewport: { width: viewports[0], height } })
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      const meta: SnapshotMeta = await page.evaluate(() => {
        const favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href
        const bodyBg = getComputedStyle(document.body).backgroundColor
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        return {
          title: document.title,
          ...(favicon ? { favicon } : {}),
          backgroundColor: bodyBg,
          colorScheme: dark ? ('dark' as const) : ('light' as const),
        }
      })
      await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))

      const assets = await downloadAssets(page, outDir)
      await captureStates(page, outDir)
      const charts = await detectCharts(page)
      if (charts.length > 0) {
        await writeFile(path.join(outDir, 'charts.json'), JSON.stringify(charts, null, 2))
        snapshotCharts = 'charts.json'
      }
      if (assets.failed.length > 0) {
        await writeFile(
          path.join(outDir, 'assets-failed.json'),
          JSON.stringify(assets.failed, null, 2),
        )
      }
      snapshotAssets = assets.files.length > 0 ? 'assets' : undefined
    } finally {
      await page.close()
    }

    const snapshot: Snapshot = {
      input: { type: 'url', source: url },
      viewports,
      screenshots,
      dom: doms,
      ...(snapshotAssets ? { assetsDir: snapshotAssets } : {}),
      ...(snapshotCharts ? { charts: snapshotCharts } : {}),
    }
    await writeSnapshot(outDir, snapshot)
  } finally {
    await browser.close()
  }
}
