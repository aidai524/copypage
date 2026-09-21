import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { registerTimerHooks, freezeDynamic } from '../src/freeze.js'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/dynamic')

describe('freezeDynamic', () => {
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

  it('stops interval-driven content rotation', async () => {
    const page = await browser.newPage()
    await registerTimerHooks(page)
    await page.goto(server.url)
    await freezeDynamic(page)
    const t1 = await page.locator('#rotator').textContent()
    await page.waitForTimeout(300) // several 50ms intervals would have fired
    const t2 = await page.locator('#rotator').textContent()
    expect(t1).toBe(t2)
    await page.close()
  })

  it('without hooks, rotation continues (sanity)', async () => {
    const page = await browser.newPage()
    await page.goto(server.url)
    const seen = new Set<string>()
    for (let i = 0; i < 6; i++) {
      seen.add((await page.locator('#rotator').textContent()) ?? '')
      await page.waitForTimeout(80)
    }
    expect(seen.size).toBeGreaterThan(1)
    await page.close()
  })
})
