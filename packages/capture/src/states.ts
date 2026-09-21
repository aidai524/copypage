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
const INTERACTIVE = 'button, a, input, [role="button"], select, textarea'

function readStylesInPage(): (el: Element) => Record<string, string> {
  return (el: Element) => {
    const PROPS = [
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color',
      'backgroundColor', 'backgroundImage', 'borderRadius', 'boxShadow', 'border',
      'padding', 'margin', 'transform', 'opacity', 'zIndex', 'display', 'position',
      'outline',
    ] as const
    const cs = getComputedStyle(el)
    const out: Record<string, string> = {}
    for (const p of PROPS) out[p] = (cs as unknown as Record<string, string>)[p] ?? ''
    return out
  }
}

/**
 * Trigger hover/focus/active on interactive elements, capture computed styles
 * and a cropped screenshot per state.
 */
export async function captureStates(page: Page, outDir: string): Promise<StateCapture[]> {
  const statesDir = path.join(outDir, 'states')
  await mkdir(statesDir, { recursive: true })
  const results: StateCapture[] = []

  const count = Math.min(await page.locator(INTERACTIVE).count(), MAX_TARGETS)

  for (let i = 0; i < count; i++) {
    const loc = page.locator(INTERACTIVE).nth(i)
    const selector = await loc.evaluate((el) => {
      const idPart = el.id ? `#${el.id}` : ''
      const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('')
      return el.tagName.toLowerCase() + idPart + cls
    })

    const triggers: { state: StateCapture['state']; apply: () => Promise<void>; release: () => Promise<void> }[] = [
      { state: 'hover', apply: () => loc.hover(), release: () => page.mouse.move(0, 0) },
      { state: 'focus', apply: () => loc.focus(), release: () => page.evaluate(() => (document.activeElement as HTMLElement)?.blur()) },
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
        await loc.scrollIntoViewIfNeeded()
        await t.apply()
        await page.waitForTimeout(120)
        const styles = await loc.evaluate(readStylesInPage())
        const cropRel = path.join('states', `${i}.${t.state}.png`)
        await loc.screenshot({ path: path.join(outDir, cropRel), timeout: 5000 })
        results.push({ selector, state: t.state, styles: styles as ComputedStyles, crop: cropRel })
      } catch {
        // element vanished / not hittable — skip this state
      } finally {
        await t.release().catch(() => {})
      }
    }
  }

  return results
}
