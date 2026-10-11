import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { detectDynamicRegions, mergeRegions } from '../src/dynamic.js'
import { freezeDynamic, registerTimerHooks, unfreezeDynamic } from '../src/freeze.js'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/live-feed')

function intersects(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

describe('detectDynamicRegions', () => {
  let browser: Browser
  let server: StaticServer

  beforeAll(async () => {
    browser = await chromium.launch()
    server = await serveStatic(FIXTURE)
  }, 60000)

  afterAll(async () => {
    await browser.close()
    await server.close()
  })

  it('finds live-updating text and added nodes, not static content', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.goto(server.url)
    const clockBox = (await page.locator('#clock').boundingBox())!
    const titleBox = (await page.locator('#static-title').boundingBox())!
    const regions = await detectDynamicRegions(page, { durationMs: 1000 })
    await page.close()

    expect(regions.length).toBeGreaterThan(0)
    // the ticking clock (characterData) is covered
    expect(regions.some((r) => intersects(r.box, clockBox))).toBe(true)
    // the feed (childList) is covered
    const feedBox = { x: 20, y: clockBox.y + 40, width: 200, height: 60 }
    expect(regions.some((r) => intersects(r.box, feedBox))).toBe(true)
    // static heading is not
    expect(regions.some((r) => r.selector === 'h1')).toBe(false)
  }, 60000)

  it('freezeDynamic stops updates; unfreeze re-opens new timers', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await registerTimerHooks(page)
    await page.goto(server.url)
    await page.waitForTimeout(400)

    await freezeDynamic(page)
    const frozen = await page.textContent('#clock')
    await page.waitForTimeout(600)
    expect(await page.textContent('#clock')).toBe(frozen)

    await unfreezeDynamic(page)
    await page.evaluate(`setInterval(() => { document.getElementById('clock').textContent = 'u' + Date.now() }, 100)`)
    const t1 = await page.textContent('#clock')
    await page.waitForTimeout(400)
    expect(await page.textContent('#clock')).not.toBe(t1)
    await page.close()
  }, 60000)
})

describe('mergeRegions', () => {
  it('merges overlapping and adjacent rects, keeps separate ones', () => {
    const merged = mergeRegions(
      [
        { selector: 'a', box: { x: 0, y: 0, width: 10, height: 10 }, reason: 'text', count: 1 },
        { selector: 'b', box: { x: 8, y: 0, width: 10, height: 10 }, reason: 'text', count: 2 },
        { selector: 'c', box: { x: 100, y: 100, width: 5, height: 5 }, reason: 'added', count: 1 },
      ],
      0,
    )
    expect(merged).toHaveLength(2)
    const big = merged.find((r) => r.count === 3)!
    expect(big.box).toEqual({ x: 0, y: 0, width: 18, height: 10 })
    expect(merged.find((r) => r.count === 1 && r.box.x === 100)).toBeDefined()
  })
})
