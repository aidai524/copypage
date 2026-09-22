import type { Page } from 'playwright'

export interface HeightAdaptiveSection {
  selector: string
  heightAtBase: number
  heightAtTall: number
  /** heightDelta / viewportDelta; 1.0 ≈ 100vh */
  ratio: number
}

export interface FluidFontInfo {
  enabled: boolean
  baseWidth: number
  wideWidth: number
  atBase: number
  atWide: number
  /** font px gained per vw px beyond baseWidth (0 when disabled) */
  perVw: number
}

export interface AdaptiveInfo {
  heightAdaptiveSections: HeightAdaptiveSection[]
  fluidFont: FluidFontInfo
}

const BASE_W = 1440
const BASE_H = 900
const TALL_H = 1200
const WIDE_W = 1920

/**
 * Detect viewport-adaptive behavior by resizing the live page (no reload):
 * - sections whose height tracks viewport height (100vh heroes) — resize H
 * - rem-based fluid scaling (html font-size tracks viewport width) — resize W
 * The page is restored to the base viewport afterwards.
 */
export async function detectAdaptive(page: Page): Promise<AdaptiveInfo> {
  // -- height adaptive: measure full-width sections at two heights
  const collect = () =>
    page.evaluate(`(() => {
      const out = []
      for (const el of Array.from(document.querySelectorAll('section, main > div, footer'))) {
        const r = el.getBoundingClientRect()
        if (r.width >= window.innerWidth * 0.9 && r.height > 100) {
          const idPart = el.id ? '#' + el.id : ''
          const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('')
          out.push({ selector: el.tagName.toLowerCase() + idPart + cls, height: r.height })
        }
      }
      return out
    })()`)

  await page.setViewportSize({ width: BASE_W, height: BASE_H })
  await page.waitForTimeout(120)
  const atBase = (await collect()) as { selector: string; height: number }[]
  await page.setViewportSize({ width: BASE_W, height: TALL_H })
  await page.waitForTimeout(120)
  const atTall = (await collect()) as { selector: string; height: number }[]

  const heightAdaptiveSections: HeightAdaptiveSection[] = []
  for (const b of atBase) {
    const t = atTall.find((x) => x.selector === b.selector)
    if (!t) continue
    const ratio = (t.height - b.height) / (TALL_H - BASE_H)
    if (ratio > 0.8) {
      heightAdaptiveSections.push({
        selector: b.selector,
        heightAtBase: Math.round(b.height),
        heightAtTall: Math.round(t.height),
        ratio: +ratio.toFixed(2),
      })
    }
  }

  // -- fluid font: html font-size at two widths
  const readFont = () => page.evaluate(`parseFloat(getComputedStyle(document.documentElement).fontSize)`)
  await page.setViewportSize({ width: BASE_W, height: BASE_H })
  await page.waitForTimeout(120)
  const atBaseFont = (await readFont()) as number
  await page.setViewportSize({ width: WIDE_W, height: BASE_H })
  await page.waitForTimeout(120)
  const atWideFont = (await readFont()) as number

  const perVw = (atWideFont - atBaseFont) / (WIDE_W - BASE_W)
  const fluidFont: FluidFontInfo = {
    enabled: perVw > 0.0005,
    baseWidth: BASE_W,
    wideWidth: WIDE_W,
    atBase: atBaseFont,
    atWide: atWideFont,
    perVw: +perVw.toFixed(6),
  }

  // restore base viewport
  await page.setViewportSize({ width: BASE_W, height: BASE_H })

  return { heightAdaptiveSections, fluidFont }
}
