import type { Page } from 'playwright'

export interface InteractionFinding {
  /** css-ish selector of the clicked element */
  trigger: string
  triggerText?: string
  /** what the click changed, human-readable (e.g. 'panel two shown, panel one hidden') */
  summary: string
  /** raw counts for downstream classification */
  mutationCount: number
}

const MAX_CANDIDATES = 30
const CLICK_WAIT_MS = 700

/**
 * Interaction discovery: click candidate triggers one by one with a
 * MutationObserver recording; report which clicks change page content.
 * Catches tab widgets, accordions, carousels — things static captures miss.
 */
export async function discoverInteractions(page: Page): Promise<InteractionFinding[]> {
  // The state pass clicks real elements, so a click may have followed a link: the
  // document can be mid-navigation here, where document.body does not exist yet.
  // Wait briefly, then treat "no body" as "nothing to discover" rather than
  // failing the whole capture over an optional enrichment step.
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
  const installed = (await page
    .evaluate(`(() => {
    const target = document.body || document.documentElement
    if (!target) return false
    window.__cpMuts = []
    window.__cpObserver = new MutationObserver((ms) => {
      for (const m of ms) {
        window.__cpMuts.push({
          type: m.type,
          added: m.addedNodes.length,
          removed: m.removedNodes.length,
          attr: m.attributeName || null,
          targetCls: (m.target.className && m.target.className.slice ? m.target.className.slice(0, 60) : ''),
        })
      }
    })
    window.__cpObserver.observe(target, { childList: true, subtree: true, attributes: true, characterData: true })
    return true
  })()`)
    .catch(() => false)) as boolean
  if (!installed) return []

  const candidates: { selector: string; text: string }[] = await page.evaluate(`(() => {
    const els = Array.from(document.querySelectorAll(
      'button, [role="tab"], [aria-selected], a[href^="#"], .swiper-pagination-bullet, [class*="pagination"] *, [class*="tab"], [class*="accordion"] > *, [class*="toggle"]'
    )).filter((el) => {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return r.width > 10 && r.height > 10 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.disabled
    }).slice(0, ${MAX_CANDIDATES})
    return els.map((el, i) => {
      el.setAttribute('data-cp-cand', String(i))
      // block default navigation only; other click handlers (tab JS etc.) still run
      el.addEventListener('click', (e) => e.preventDefault(), true)
      const idPart = el.id ? '#' + el.id : ''
      const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('')
      return { selector: el.tagName.toLowerCase() + idPart + cls, text: (el.textContent || '').trim().slice(0, 40) }
    })
  })()`)

  // text snapshot helper (visible text of body)
  const textSnapshot = () =>
    page.evaluate(`document.body ? document.body.innerText : ''`) as Promise<string>

  const findings: InteractionFinding[] = []

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i]
    const before = await textSnapshot()
    await page.evaluate(`(() => { window.__cpMuts = [] })()`)
    const loc = page.locator(`[data-cp-cand="${i}"]`).first()
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 1500 })
      await loc.click({ timeout: 2000 })
    } catch {
      continue // not clickable right now
    }
    await page.waitForTimeout(CLICK_WAIT_MS)

    let after: string
    let muts: number
    try {
      after = await textSnapshot()
      muts = (await page.evaluate(`window.__cpMuts ? window.__cpMuts.length : -1`)) as number
    } catch {
      continue // page navigated / context destroyed despite preventDefault
    }
    if (muts === -1) continue
    if (after === before && muts < 3) continue

    // summarize: new visible text fragments
    const beforeSet = new Set(before.split('\n').map((s) => s.trim()).filter(Boolean))
    const newBits = after
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !beforeSet.has(s))
      .slice(0, 4)
    const summary = newBits.length
      ? `shows: ${newBits.join(' | ')}`
      : `${muts} mutations (class/attr changes)`

    findings.push({
      trigger: cand.selector,
      triggerText: cand.text || undefined,
      summary,
      mutationCount: muts,
    })
  }

  await page.evaluate(`(() => { window.__cpObserver && window.__cpObserver.disconnect() })()`)
  return findings
}
