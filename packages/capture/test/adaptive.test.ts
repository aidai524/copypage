import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { detectAdaptive } from '../src/adaptive.js'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/adaptive')

describe('detectAdaptive', () => {
  let browser: Browser
  let server: StaticServer

  beforeAll(async () => {
    browser = await chromium.launch()
    server = await serveStatic(FIXTURE)
  })
  afterAll(async () => {
    await browser.close()
    await server.close()
  })

  it('flags 100vh sections and skips fixed-height ones', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(server.url)
    const info = await detectAdaptive(page)
    await page.close()

    const hero = info.heightAdaptiveSections.find((s) => s.selector.includes('hero'))
    expect(hero).toBeDefined()
    expect(hero!.ratio).toBeCloseTo(1, 1)
    expect(info.heightAdaptiveSections.find((s) => s.selector.includes('content'))).toBeUndefined()
    expect(info.heightAdaptiveSections.find((s) => s.selector.includes('twin'))).toBeUndefined()
  })

  it('detects fluid html font scaling with curve parameters', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(server.url)
    const info = await detectAdaptive(page)
    await page.close()

    expect(info.fluidFont.enabled).toBe(true)
    expect(info.fluidFont.atBase).toBeCloseTo(10, 0)
    expect(info.fluidFont.atWide).toBeGreaterThan(12)
    expect(info.fluidFont.baseWidth).toBe(1440)
  })
})
