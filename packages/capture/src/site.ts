import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeSnapshot, type DomSnapshot, type Snapshot, type SnapshotMeta } from '@copypage/core'
import { autoScroll, probeDom } from './probe.js'
import { downloadAssets } from './assets.js'
import { captureStates } from './states.js'
import { detectCharts } from './charts.js'
import { discoverInteractions } from './interactions.js'
import { freezeDynamic, registerTimerHooks, unfreezeDynamic } from './freeze.js'
import { detectDynamicRegions, type DynamicRegion } from './dynamic.js'
import { detectAdaptive } from './adaptive.js'
import { dismissOverlays, type Dismissal } from './dismiss.js'

export interface CaptureSiteOptions {
  viewports?: number[]
  /** page height for each viewport; defaults to 900 */
  viewportHeight?: number
  /** run interaction-state capture (expensive: N elements × 3 states × screenshot) */
  states?: boolean
  /** auto-dismiss cookie banners / first-visit modals before capture; default true */
  dismiss?: boolean
  /** DOM probe node budget; raise for large live feeds (default 4000) */
  maxNodes?: number
  /** sample the live page for mutations and record dynamic regions; default true */
  dynamic?: boolean
  /** dynamic-region sampling window per viewport; default 2500ms */
  dynamicDurationMs?: number
}

const DEFAULT_VIEWPORTS = [1440, 768, 375]

const log = (msg: string) => console.error(`[capture] ${msg}`)

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
  let snapshotDismissed: string | undefined
  let snapshotDynamic: string | undefined
  const allDismissals: Dismissal[] = []
  const dynamicByViewport: Record<string, DynamicRegion[]> = {}
  try {
    const screenshots: Record<string, string> = {}
    const doms: DomSnapshot[] = []

    for (const width of viewports) {
      log(`viewport ${width}: loading ${url}`)
      const page = await browser.newPage({ viewport: { width, height } })
      await registerTimerHooks(page)
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
        // heavy sites never reach networkidle — wait bounded settle instead
        await page.waitForLoadState('load', { timeout: 20000 }).catch(() => {})
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
        if (opts.dismiss !== false) {
          allDismissals.push(...(await dismissOverlays(page)))
        }
        await autoScroll(page)
        if (opts.dismiss !== false) {
          allDismissals.push(...(await dismissOverlays(page)))
        }
        // sample live mutations BEFORE freezing: a frozen page drives no diffs
        if (opts.dynamic !== false) {
          const regions = await detectDynamicRegions(page, { durationMs: opts.dynamicDurationMs })
          if (regions.length > 0) {
            dynamicByViewport[String(width)] = regions
            log(`dynamic: ${regions.length} regions @${width}`)
          }
        }
        await freezeDynamic(page)
        const shotRel = `screenshots/${width}.png`
        await page.screenshot({
          path: path.join(outDir, shotRel),
          fullPage: true,
          animations: 'disabled', // jump CSS animations to their end state
        })
        const root = await probeDom(page, opts.maxNodes)
        log(`viewport ${width}: done`)
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
    await registerTimerHooks(page)
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
      log('meta pass: loaded, scrolling')
      if (opts.dismiss !== false) {
        allDismissals.push(...(await dismissOverlays(page)))
      }
      await autoScroll(page) // lazy assets/charts/interactive elements render on scroll
      if (opts.dismiss !== false) {
        allDismissals.push(...(await dismissOverlays(page)))
      }
      await freezeDynamic(page)
      const adaptive = await detectAdaptive(page)
      await writeFile(path.join(outDir, 'adaptive.json'), JSON.stringify(adaptive, null, 2))
      if (adaptive.heightAdaptiveSections.length > 0 || adaptive.fluidFont.enabled) {
        log(
          `adaptive: ${adaptive.heightAdaptiveSections.length} vh-sections, fluidFont=${adaptive.fluidFont.enabled}`,
        )
      }
      const meta: SnapshotMeta = await page.evaluate(`(() => {
        const favicon = document.querySelector('link[rel~="icon"]')?.href
        const bodyBg = getComputedStyle(document.body).backgroundColor
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
        return {
          title: document.title,
          ...(favicon ? { favicon } : {}),
          backgroundColor: bodyBg,
          colorScheme: dark ? 'dark' : 'light',
        }
      })()`) as SnapshotMeta
      await writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))

      const assets = await downloadAssets(page, outDir)
      log(`assets: ${assets.files.length} ok, ${assets.failed.length} failed`)
      if (opts.states !== false) {
        // reopen the data gate so hover/click captures can trigger app behavior
        await unfreezeDynamic(page)
        await captureStates(page, outDir)
        log('states: done')
      }
      const charts = await detectCharts(page)
      log(`charts: ${charts.length} found`)
      if (charts.length > 0) {
        await writeFile(path.join(outDir, 'charts.json'), JSON.stringify(charts, null, 2))
        snapshotCharts = 'charts.json'
      }
      if (opts.states !== false) {
        // interaction discovery runs LAST: clicks may leave the page in a changed state
        const interactions = await discoverInteractions(page)
        if (interactions.length > 0) {
          await writeFile(path.join(outDir, 'interactions.json'), JSON.stringify(interactions, null, 2))
        }
        log(`interactions: ${interactions.length} clickable triggers found`)
      }
      if (assets.failed.length > 0) {
        await writeFile(
          path.join(outDir, 'assets-failed.json'),
          JSON.stringify(assets.failed, null, 2),
        )
      }
      if (allDismissals.length > 0) {
        await writeFile(
          path.join(outDir, 'dismissed.json'),
          JSON.stringify(allDismissals, null, 2),
        )
        snapshotDismissed = 'dismissed.json'
      }
      if (Object.keys(dynamicByViewport).length > 0) {
        await writeFile(
          path.join(outDir, 'dynamic.json'),
          JSON.stringify(dynamicByViewport, null, 2),
        )
        snapshotDynamic = 'dynamic.json'
        const masked = Object.values(dynamicByViewport).flat()
        log(`dynamic: ${masked.length} regions recorded across viewports`)
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
      ...(snapshotDismissed ? { dismissed: snapshotDismissed } : {}),
      ...(snapshotDynamic ? { dynamic: snapshotDynamic } : {}),
    }
    await writeSnapshot(outDir, snapshot)
  } finally {
    await browser.close()
  }
}
