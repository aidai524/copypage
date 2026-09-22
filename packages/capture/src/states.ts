import type { Page } from 'playwright'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ComputedStyles } from '@copypage/core'

export interface StateCapture {
  selector: string
  state: 'hover' | 'focus' | 'active'
  styles: ComputedStyles
  /** path to element crop screenshot, relative to outDir */
  crop: string
}

const MAX_TARGETS = 50

// string source — avoids TS transpile helpers leaking into the browser
const READ_STYLES_SRC = `(el) => {
  const PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'color',
    'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'borderRadius', 'boxShadow', 'border',
    'padding', 'margin', 'transform', 'opacity', 'zIndex', 'display', 'position',
    'outline',
  ]
  const cs = getComputedStyle(el)
  const out = {}
  for (const p of PROPS) out[p] = cs[p] ?? ''
  return out
}`

// tag interactive elements with data-cp-idx, return their selectors
const TAG_SRC = `(() => {
  const els = Array.from(document.querySelectorAll('button, a, input, [role="button"], select, textarea')).slice(0, ${MAX_TARGETS})
  return els.map((el, i) => {
    el.setAttribute('data-cp-idx', String(i))
    const idPart = el.id ? '#' + el.id : ''
    const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('')
    return { idx: i, selector: el.tagName.toLowerCase() + idPart + cls }
  })
})()`

const UNTAG_SRC = `(() => {
  for (const el of Array.from(document.querySelectorAll('[data-cp-idx]'))) el.removeAttribute('data-cp-idx')
})()`

/**
 * Trigger hover/focus/active on interactive elements, capture computed styles
 * and a cropped screenshot per state.
 */
export async function captureStates(page: Page, outDir: string): Promise<StateCapture[]> {
  const statesDir = path.join(outDir, 'states')
  await mkdir(statesDir, { recursive: true })
  const results: StateCapture[] = []

  const targets: { idx: number; selector: string }[] = await page.evaluate(TAG_SRC)

  for (const { idx, selector } of targets) {
    const i = idx
    const loc = page.locator(`[data-cp-idx="${i}"]`)
    // skip hidden/detached elements fast instead of waiting out actionability timeouts
    if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) continue

    const triggers: { state: StateCapture['state']; apply: () => Promise<void>; release: () => Promise<void> }[] = [
      { state: 'hover', apply: () => loc.hover({ timeout: 2000 }), release: () => page.mouse.move(0, 0) },
      {
        state: 'focus',
        apply: () => loc.focus({ timeout: 2000 }),
        release: () => page.evaluate(`(() => { const a = document.activeElement; if (a && a.blur) a.blur() })()`),
      },
      {
        state: 'active',
        apply: async () => {
          const box = await loc.boundingBox()
          if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.down()
        },
        release: () => page.mouse.up(),
      },
    ]

    for (const t of triggers) {
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 })
        await t.apply()
        await page.waitForTimeout(120)
        const styles = await page.evaluate(
          `(${READ_STYLES_SRC})(document.querySelector('[data-cp-idx="${i}"]'))`,
        )
        const cropRel = path.join('states', `${i}.${t.state}.png`)
        await loc.screenshot({ path: path.join(outDir, cropRel), timeout: 2000 })
        results.push({ selector, state: t.state, styles: styles as ComputedStyles, crop: cropRel })
      } catch {
        // element vanished / not hittable — skip this state
      } finally {
        await t.release().catch(() => {})
      }
    }
  }

  await page.evaluate(UNTAG_SRC).catch(() => {})
  return results
}
