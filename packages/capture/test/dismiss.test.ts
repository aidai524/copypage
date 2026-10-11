import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { dismissOverlays } from '../src/dismiss.js'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/overlays')

describe('dismissOverlays', () => {
  let browser: Browser
  let server: StaticServer
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch()
    server = await serveStatic(FIXTURE)
    page = await browser.newPage({ viewport: { width: 800, height: 900 } })
    await page.goto(server.url)
  }, 60000)

  afterAll(async () => {
    await page.close()
    await browser.close()
    await server.close()
  })

  it('closes the modal and the cookie banner', async () => {
    const dismissed = await dismissOverlays(page)
    expect(dismissed.map((d) => d.label)).toContain('Continue')
    expect(dismissed.map((d) => d.label)).toContain('Accept all')
    expect(await page.locator('#welcome-modal').isVisible()).toBe(false)
    expect(await page.locator('#banner-x').isVisible()).toBe(false)
  })

  it('does not click unrelated buttons', async () => {
    expect(await page.locator('#nav-next').getAttribute('data-clicked')).toBeNull()
    expect(await page.locator('#decoy-accept').getAttribute('data-clicked')).toBeNull()
  })

  it('is idempotent when nothing is left to dismiss', async () => {
    const again = await dismissOverlays(page)
    expect(again).toHaveLength(0)
  })
})
