import type { BoxModel, ElementNode } from '@copypage/core'

export interface Alignment {
  pairs: [ElementNode, ElementNode][]
  /** in orig, not matched in repro */
  missing: ElementNode[]
  /** in repro, not matched in orig */
  extra: ElementNode[]
  failureRate: number
}

function hIou(a: BoxModel, b: BoxModel): number {
  const x1 = Math.max(a.x, b.x)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const inter = Math.max(0, x2 - x1)
  const union = a.width + b.width - inter
  return union <= 0 ? 0 : inter / union
}

function textSim(a?: string, b?: string): number {
  if (!a || !b) return 0
  const t1 = a.trim()
  const t2 = b.trim()
  if (t1 === t2) return 1
  if (t1.includes(t2) || t2.includes(t1)) return 0.7
  return 0
}

function sizeSim(a: BoxModel, b: BoxModel): number {
  const h = Math.min(a.height, b.height) / Math.max(a.height, b.height, 1)
  const w = Math.min(a.width, b.width) / Math.max(a.width, b.width, 1)
  return (h + w) / 2
}

function countNodes(n: ElementNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0)
}

function flatten(n: ElementNode, out: ElementNode[] = []): ElementNode[] {
  out.push(n)
  for (const c of n.children) flatten(c, out)
  return out
}

/**
 * Align two DOM trees from DIFFERENT implementations. Wrapper divergence
 * (React root divs, main tags, different nesting) makes level-wise matching
 * useless, so this matches globally: same tag + composite score of
 * horizontal position (stable under vertical drift), text content, and size.
 */
export function alignTrees(
  orig: ElementNode,
  repro: ElementNode,
  idMap?: Map<string, string>,
): Alignment {
  const origAll = flatten(orig)
  const reproAll = flatten(repro)
  const usedO = new Set<ElementNode>()
  const usedR = new Set<ElementNode>()
  const pairs: [ElementNode, ElementNode][] = []

  // roots always pair
  pairs.push([orig, repro])
  usedO.add(orig)
  usedR.add(repro)

  // idMap pass
  if (idMap) {
    for (const o of origAll) {
      const rid = idMap.get(o.id)
      if (!rid || usedO.has(o)) continue
      const r = reproAll.find((n) => n.id === rid && !usedR.has(n))
      if (r) {
        usedO.add(o)
        usedR.add(r)
        pairs.push([o, r])
      }
    }
  }

  // global greedy by composite score
  const candidates: { o: ElementNode; r: ElementNode; score: number }[] = []
  for (const o of origAll) {
    if (usedO.has(o)) continue
    for (const r of reproAll) {
      if (usedR.has(r)) continue
      if (o.tag !== r.tag) continue
      // fixed/absolute vs static mismatch → different layout roles, never pair
      const oFixed = o.styles.position === 'fixed'
      const rFixed = r.styles.position === 'fixed'
      if (oFixed !== rFixed) continue
      // invisible ↔ visible (carousel off-slides etc.) never pair
      const oHidden = parseFloat(o.styles.opacity || '1') === 0
      const rHidden = parseFloat(r.styles.opacity || '1') === 0
      if (oHidden !== rHidden) continue
      const score = 0.4 * hIou(o.box, r.box) + 0.4 * textSim(o.text, r.text) + 0.2 * sizeSim(o.box, r.box)
      if (score >= 0.55) candidates.push({ o, r, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  for (const c of candidates) {
    if (usedO.has(c.o) || usedR.has(c.r)) continue
    usedO.add(c.o)
    usedR.add(c.r)
    pairs.push([c.o, c.r])
  }

  const missing = origAll.filter((n) => !usedO.has(n))
  const extra = reproAll.filter((n) => !usedR.has(n))
  const total = countNodes(orig) + countNodes(repro)
  const unmatched = missing.reduce((s, n) => s + 1, 0) + extra.reduce((s, n) => s + 1, 0)
  return { pairs, missing, extra, failureRate: total ? unmatched / total : 0 }
}
