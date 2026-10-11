import type { Page } from 'playwright'

export interface DynamicRegion {
  /** css-ish selector of the element that changed (best effort) */
  selector: string
  box: { x: number; y: number; width: number; height: number }
  reason: 'text' | 'added' | 'removed'
  /** observed mutation count during the sampling window */
  count: number
}

/**
 * Page-side observer source (string for clean serialization). Records every
 * element touched by characterData/childList mutations for durationMs, then
 * snapshots their bounding boxes.
 */
const OBSERVE_SRC = `(durationMs) => {
  return new Promise((resolve) => {
    const MAX_HITS = 4000
    const hits = new Map()
    const record = (el, reason) => {
      if (!el || el.nodeType !== 1 || !el.isConnected) return
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      const prev = hits.get(el)
      if (prev) {
        prev.count++
        if (reason === 'text') prev.reason = 'text'
        return
      }
      if (hits.size >= MAX_HITS) return
      hits.set(el, { reason, count: 1 })
    }
    const buildSelector = (el) => {
      const idPart = el.id ? '#' + el.id : ''
      const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('')
      return el.tagName.toLowerCase() + idPart + cls
    }
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'characterData') {
          record(m.target.parentElement, 'text')
        } else if (m.type === 'childList') {
          m.addedNodes.forEach((n) => record(n.nodeType === 1 ? n : n.parentElement, 'added'))
          m.removedNodes.forEach((n) => record(n.nodeType === 1 ? n.parentElement : n.parentElement, 'removed'))
        }
      }
    })
    mo.observe(document.body, { subtree: true, childList: true, characterData: true })
    setTimeout(() => {
      mo.disconnect()
      const out = []
      for (const [el, info] of hits) {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        out.push({
          selector: buildSelector(el),
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
          reason: info.reason,
          count: info.count,
        })
      }
      resolve(out)
    }, durationMs)
  })
}`

/**
 * Sample the live page for mutations and return the regions whose content is
 * inherently dynamic (live feeds, tickers, clocks). Must run BEFORE
 * freezeDynamic — a frozen page produces no mutations.
 *
 * Pixel diff uses these boxes as masks: live data cannot be reproduced from a
 * DOM snapshot, so it should not poison layout/style convergence.
 */
export async function detectDynamicRegions(
  page: Page,
  opts: { durationMs?: number; pad?: number } = {},
): Promise<DynamicRegion[]> {
  const durationMs = opts.durationMs ?? 2500
  const raw = (await page.evaluate(`(${OBSERVE_SRC})(${durationMs})`).catch(() => [])) as DynamicRegion[]
  if (!Array.isArray(raw) || raw.length === 0) return []
  return mergeRegions(raw, opts.pad ?? 2)
}

/**
 * Merge overlapping/nearby boxes so the diff masks don't double-count and the
 * report shows a handful of regions instead of hundreds of tiny rects.
 */
export function mergeRegions(regions: DynamicRegion[], pad = 2): DynamicRegion[] {
  const rects = regions
    .map((r) => ({
      x0: r.box.x - pad,
      y0: r.box.y - pad,
      x1: r.box.x + r.box.width + pad,
      y1: r.box.y + r.box.height + pad,
      reason: r.reason,
      selector: r.selector,
      count: r.count,
    }))
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)

  const merged: typeof rects = []
  for (const r of rects) {
    let cur = r
    let absorbed = false
    for (const m of merged) {
      const overlaps = cur.x0 <= m.x1 && cur.x1 >= m.x0 && cur.y0 <= m.y1 && cur.y1 >= m.y0
      if (!overlaps) continue
      m.x0 = Math.min(m.x0, cur.x0)
      m.y0 = Math.min(m.y0, cur.y0)
      m.x1 = Math.max(m.x1, cur.x1)
      m.y1 = Math.max(m.y1, cur.y1)
      m.count += cur.count
      absorbed = true
      cur = m
    }
    if (!absorbed) merged.push(cur)
  }

  // a merge can bridge two clusters — run once more until stable (small n)
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i]
        const b = merged[j]
        if (a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0) {
          a.x0 = Math.min(a.x0, b.x0)
          a.y0 = Math.min(a.y0, b.y0)
          a.x1 = Math.max(a.x1, b.x1)
          a.y1 = Math.max(a.y1, b.y1)
          a.count += b.count
          merged.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
  }

  return merged.map((m) => ({
    selector: m.selector,
    box: { x: m.x0, y: m.y0, width: m.x1 - m.x0, height: m.y1 - m.y0 },
    reason: m.reason,
    count: m.count,
  }))
}
