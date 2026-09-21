import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { serveStatic, type StaticServer, type ElementNode } from '@copypage/core'
import { probeDom, autoScroll } from '../src/probe.js'
import path from 'node:path'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')

function findBySelector(node: ElementNode, sel: string): ElementNode | undefined {
  if (node.selector.includes(sel)) return node
  for (const c of node.children) {
    const hit = findBySelector(c, sel)
    if (hit) return hit
  }
  return undefined
}

function* walkAll(node: ElementNode): Generator<ElementNode> {
  yield node
  for (const c of node.children) yield* walkAll(c)
}

describe('probeDom', () => {
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

  it('extracts computed styles for the cta button', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.goto(server.url)
    await autoScroll(page)
    const root = await probeDom(page)
    await page.close()

    expect(root.tag).toBe('body')
    const cta = findBySelector(root, 'button.cta')
    expect(cta).toBeDefined()
    expect(cta!.styles.borderRadius).toBe('12px')
    expect(cta!.styles.boxShadow).toContain('rgba(99, 102, 241')
    expect(cta!.styles.padding).toBe('16px 32px')
    expect(cta!.box.width).toBeGreaterThan(0)
  })

  it('captures lazy-loaded content after autoscroll', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.goto(server.url)
    await autoScroll(page)
    const root = await probeDom(page)
    await page.close()

    const ids = [...walkAll(root)].map((n) => n.selector).join(' ')
    expect(ids).toContain('lazy-content')
  })

  it('captures img src / a href attributes', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.goto(server.url)
    const root = await probeDom(page)
    await page.close()

    const img = findBySelector(root, 'img')
    expect(img?.attrs?.src).toContain('logo.png')
    let link: ElementNode | undefined
    for (const n of walkAll(root)) if (n.tag === 'a') { link = n; break }
    expect(link?.attrs?.href).toContain('#features')
  })

  it('skips invisible elements and assigns path ids', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.goto(server.url)
    const root = await probeDom(page)
    await page.close()

    expect(root.id).toBe('0')
    for (const c of root.children) expect(c.id.startsWith('0/')).toBe(true)
  })
})
