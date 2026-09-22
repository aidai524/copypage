import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { discoverInteractions } from '../src/interactions.js'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/interactive')

describe('discoverInteractions', () => {
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

  it('discovers that clicking tabs changes page content', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await page.goto(server.url)
    const interactions = await discoverInteractions(page)
    await page.close()

    // Tab Two and Tab Three clicks must be detected as content-changing
    const triggers = interactions.map((i) => i.trigger)
    expect(triggers.some((t) => t.includes('tab'))).toBe(true)
    expect(interactions.length).toBeGreaterThanOrEqual(2)

    const two = interactions.find((i) => i.triggerText?.includes('Two'))
    expect(two).toBeDefined()
    expect(two!.summary).toContain('panel two')
  })

  it('does not report inert elements', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
    await page.goto(server.url)
    const interactions = await discoverInteractions(page)
    await page.close()
    // the already-active tab click produces no change → not reported
    expect(interactions.find((i) => i.triggerText?.includes('One') && i.summary === '')).toBeUndefined()
  })
})
