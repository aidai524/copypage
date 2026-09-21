import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { detectCharts } from '../src/charts.js'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')

describe('detectCharts', () => {
  let browser: Browser
  let server: StaticServer
  let findings: Awaited<ReturnType<typeof detectCharts>>

  beforeAll(async () => {
    browser = await chromium.launch()
    server = await serveStatic(FIXTURE)
    const page = await browser.newPage()
    await page.goto(server.url)
    findings = await detectCharts(page)
    await page.close()
  }, 60000)

  afterAll(async () => {
    await browser.close()
    await server.close()
  })

  it('detects the highcharts registry with full options', () => {
    const hc = findings.find((f) => f.library === 'highcharts')
    expect(hc).toBeDefined()
    const options = hc!.options as { series: { data: number[] }[] }
    expect(options.series[0].data).toEqual([120, 200, 150])
  })
})
