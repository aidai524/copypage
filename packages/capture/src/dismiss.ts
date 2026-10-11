import type { Page } from 'playwright'

export interface Dismissal {
  kind: 'cookie' | 'modal'
  label: string
  selector: string
}

interface Candidate {
  kind: 'cookie' | 'modal'
  label: string
  selector: string
  priority: number
}

/**
 * Page-side candidate finder. Kept as a STRING: TS transpilation helpers can
 * leak into serialized functions and break page.evaluate.
 *
 * Candidates are marked with data-copypage-dismiss so Playwright can click
 * them with a real user gesture. Both cookie-consent banners and aria-modal
 * dialogs are handled; unrelated buttons (e.g. nav "Next") are never touched.
 */
const FIND_SRC = `() => {
  const COOKIE_CONTAINER = '[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[id*=gdpr i],[class*=gdpr i],[class*=privacy i]'
  const COOKIE_HINT = /cookie|consent|privacy|gdpr|tracking/i
  const STRONG = [
    [/^accept all( cookies)?$/i, 100],
    [/^accept cookies$/i, 100],
    [/^agree to all$/i, 95],
    [/^allow all$/i, 90],
    [/^reject all$/i, 85],
    [/^accept$/i, 80],
    [/^agree$/i, 75],
    [/^allow$/i, 70],
    [/^(got it|ok|okay)$/i, 60],
  ]
  const MODAL_CLOSE = /^(continue|got it|ok|okay|agree|accept|close|dismiss|i understand|understood|let's go|start|next|enter|skip|no thanks)$/i

  function visible(el) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0'
  }
  function label(el) {
    return (el.textContent || '').trim().replace(/\\s+/g, ' ')
  }
  function area(el) {
    const r = el.getBoundingClientRect()
    return r.width * r.height
  }

  // 1) cookie / consent banners: known class/id patterns + text-based
  //    discovery (walk up from any node mentioning cookies to its overlay)
  const containers = new Set()
  for (const el of document.querySelectorAll(COOKIE_CONTAINER)) {
    if (visible(el)) containers.add(el)
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent
    if (!t || !COOKIE_HINT.test(t)) continue
    let el = walker.currentNode.parentElement
    for (let i = 0; i < 8 && el && el !== document.body; i++) {
      const cs = getComputedStyle(el)
      if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') {
        if (visible(el)) containers.add(el)
        break
      }
      el = el.parentElement
    }
  }

  const out = []
  let seq = 0
  const seenButtons = new Set()
  function mark(kind, el, lab, priority) {
    const id = 'cp-' + (seq++)
    const sel = '[data-copypage-dismiss="' + id + '"]'
    el.setAttribute('data-copypage-dismiss', id)
    out.push({ kind: kind, label: lab, selector: sel, priority: priority })
  }

  for (const container of containers) {
    const cText = label(container).slice(0, 300)
    const hasHint = COOKIE_HINT.test(cText)
    for (const btn of container.querySelectorAll('button, [role=button], a')) {
      if (!visible(btn) || btn === container) continue
      const t = label(btn)
      if (!t || t.length > 40) continue
      for (const [re, prio] of STRONG) {
        if (re.test(t) && (hasHint || prio >= 85)) {
          if (seenButtons.has(btn)) continue
          seenButtons.add(btn)
          mark('cookie', btn, t, prio)
          break
        }
      }
    }
  }

  // 2) modal dialogs — prefer the primary (largest) dismiss button inside
  const modalCands = []
  for (const dialog of document.querySelectorAll('[role=dialog],[aria-modal=true],dialog')) {
    if (!visible(dialog)) continue
    for (const btn of dialog.querySelectorAll('button, [role=button]')) {
      if (!visible(btn)) continue
      const t = label(btn)
      if (t && t.length <= 40 && MODAL_CLOSE.test(t)) {
        modalCands.push({ btn: btn, label: t, area: area(btn) })
      }
    }
    if (modalCands.length === 0) {
      const closers = dialog.querySelectorAll('[aria-label*=close i], [class*=close i]')
      for (const c of closers) {
        if (visible(c) && area(c) < 10000) {
          modalCands.push({ btn: c, label: 'close', area: 0 })
          break
        }
      }
    }
  }
  if (modalCands.length > 0) {
    modalCands.sort((a, b) => b.area - a.area)
    const best = modalCands[0]
    mark('modal', best.btn, best.label, 100 + Math.min(best.area / 1000, 50))
  }

  return out
}`

/**
 * Dismiss cookie banners and first-visit modals that would otherwise cover the
 * page in screenshots. Clicks at most one candidate per pass, up to maxPasses.
 * Returns what was dismissed so the snapshot can record it.
 */
export async function dismissOverlays(
  page: Page,
  opts: { maxPasses?: number } = {},
): Promise<Dismissal[]> {
  const maxPasses = opts.maxPasses ?? 6
  const dismissals: Dismissal[] = []
  const tried = new Set<string>()
  const log = (msg: string) => console.error(`[capture] dismiss: ${msg}`)

  for (let pass = 0; pass < maxPasses; pass++) {
    const candidates = (await page.evaluate(`(${FIND_SRC})()`).catch(() => [])) as Candidate[]
    const fresh = candidates.filter((c) => !tried.has(`${c.kind}:${c.label}`))
    if (fresh.length === 0) break
    fresh.sort((a, b) => b.priority - a.priority)
    const chosen = fresh[0]
    tried.add(`${chosen.kind}:${chosen.label}`)

    const el = await page.$(chosen.selector)
    if (!el) continue
    try {
      await el.click({ timeout: 2500, noWaitAfter: true })
      dismissals.push({ kind: chosen.kind, label: chosen.label, selector: chosen.selector })
      log(`${chosen.kind} "${chosen.label}" closed`)
    } catch {
      log(`${chosen.kind} "${chosen.label}" click failed — skipping`)
    }
    await el.evaluate((node: Element) => node.removeAttribute('data-copypage-dismiss')).catch(() => {})
    await page.waitForTimeout(350)
  }
  return dismissals
}
