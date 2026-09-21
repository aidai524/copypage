import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { captureStates } from '../src/states.js'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')

describe('captureStates', () => {
  let browser: Browser
  let server: StaticServer
  let outDir: string
  let states: Awaited<ReturnType<typeof captureStates>>

  beforeAll(async () => {
    browser = await chromium.launch()
    server = await serveStatic(FIXTURE)
    outDir = await mkdtemp(path.join(tmpdir(), 'cp-states-'))
    const page = await browser.newPage({ viewport: { width: 800, height: 900 } })
    await page.goto(server.url)
    states = await captureStates(page, outDir)
    await page.close()
  }, 60000)

  afterAll(async () => {
    await browser.close()
    await server.close()
    await rm(outDir, { recursive: true, force: true })
  })

  it('captures hover state with different background', () => {
    const hover = states.find((s) => s.selector.includes('cta') && s.state === 'hover')
    expect(hover).toBeDefined()
    expect(hover!.styles.backgroundColor).not.toBe('rgb(99, 102, 241)')
  })

  it('captures focus state with outline', () => {
    const focus = states.find((s) => s.selector.includes('cta') && s.state === 'focus')
    expect(focus).toBeDefined()
  })

  it('writes crop screenshots for each state', async () => {
    const hover = states.find((s) => s.selector.includes('cta') && s.state === 'hover')
    await access(path.join(outDir, hover!.crop))
  })
})
