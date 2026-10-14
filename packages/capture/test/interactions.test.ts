import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { discoverInteractions } from '../src/interactions.js'

const INTERACTIVE = path.resolve(__dirname, '../../../fixtures/interactive')

describe('discoverInteractions', () => {
  let browser: Browser
  let server: StaticServer

  beforeAll(async () => {
    browser = await chromium.launch()
    server = await serveStatic(INTERACTIVE)
  }, 60_000)

  afterAll(async () => {
    await browser.close()
    await server.close()
  })

  it('reports the triggers whose click changes page content', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
    await page.goto(server.url)
    const found = await discoverInteractions(page)
    expect(found.length).toBeGreaterThan(0)
    expect(found.map((f) => f.trigger).join(' ')).toContain('div.tab')
    await page.close()
  }, 60_000)

  it('returns nothing instead of throwing when the document has no body', async () => {
    // the state pass clicks real elements, so a click may follow a link and leave
    // the page mid-navigation: document.body does not exist until the new document
    // is parsed. This used to fail the whole capture (production: example.com).
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
    await page.setContent('<html><body><p>gone</p><script>document.body.remove()</script></body></html>')
    expect(await page.evaluate('document.body === null')).toBe(true)
    await expect(discoverInteractions(page)).resolves.toEqual([])
    await page.close()
  }, 60_000)
})
