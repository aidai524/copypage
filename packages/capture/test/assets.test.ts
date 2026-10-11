import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, access, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer } from '@copypage/core'
import { downloadAssets, withContentTypeExt } from '../src/assets.js'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')

describe('downloadAssets', () => {
  let browser: Browser
  let server: StaticServer
  let outDir: string
  let result: { files: string[]; failed: { url: string; reason: string }[] }

  beforeAll(async () => {
    browser = await chromium.launch()
    server = await serveStatic(FIXTURE)
    outDir = await mkdtemp(path.join(tmpdir(), 'cp-assets-'))
    const page = await browser.newPage()
    await page.goto(server.url)
    result = await downloadAssets(page, outDir)
    await page.close()
  }, 60000)

  afterAll(async () => {
    await browser.close()
    await server.close()
    await rm(outDir, { recursive: true, force: true })
  })

  it('downloads the local png asset', async () => {
    const png = result.files.find((f) => f.endsWith('.png'))
    expect(png).toBeDefined()
    await access(path.join(outDir, png!))
  })

  it('stores inline svg source as .svg file', async () => {
    const svg = result.files.find((f) => f.endsWith('.svg'))
    expect(svg).toBeDefined()
    const content = await readFile(path.join(outDir, svg!), 'utf8')
    expect(content).toContain('<circle')
  })

  it('downloads css background-image assets', async () => {
    const bg = result.files.find((f) => f.includes('bg.png'))
    expect(bg).toBeDefined()
  })

  it('records failed downloads without throwing', async () => {
    expect(result.failed.length).toBeGreaterThanOrEqual(1)
    expect(result.failed[0].url).toContain('missing-404')
  })

  it('repairs missing extensions from content-type', () => {
    expect(withContentTypeExt('13-bafkreifoo', 'image/jpeg')).toBe('13-bafkreifoo.jpg')
    expect(withContentTypeExt('4-bg.png', 'image/jpeg')).toBe('4-bg.jpg')
    expect(withContentTypeExt('3-icon.svg', 'image/svg+xml; charset=utf-8')).toBe('3-icon.svg')
    expect(withContentTypeExt('9-weird', 'application/octet-stream')).toBe('9-weird')
  })
})
