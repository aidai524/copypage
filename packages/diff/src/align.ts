import type { BoxModel, ElementNode } from '@copypage/core'

export interface Alignment {
  pairs: [ElementNode, ElementNode][]
  /** in orig, not matched in repro */
  missing: ElementNode[]
  /** in repro, not matched in orig */
  extra: ElementNode[]
  failureRate: number
}

function iou(a: BoxModel, b: BoxModel): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.width * a.height + b.width * b.height - inter
  return union <= 0 ? 0 : inter / union
}

const IOU_THRESHOLD = 0.5

function countNodes(n: ElementNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0)
}

/**
 * Align two DOM trees. idMap (origId -> reproId) pairs first; remaining
 * siblings match greedily by same tag + IoU >= 0.5, best score first.
 */
export function alignTrees(
  orig: ElementNode,
  repro: ElementNode,
  idMap?: Map<string, string>,
): Alignment {
  const pairs: [ElementNode, ElementNode][] = []
  const missing: ElementNode[] = []
  const extra: ElementNode[] = []

  function alignLevel(origNodes: ElementNode[], reproNodes: ElementNode[]) {
    const usedRepro = new Set<ElementNode>()

    // idMap pass
    for (const o of origNodes) {
      const mapped = idMap?.get(o.id)
      if (!mapped) continue
      const r = reproNodes.find((n) => n.id === mapped && !usedRepro.has(n))
      if (r) {
        usedRepro.add(r)
        pairs.push([o, r])
      }
    }

    // greedy IoU pass for the rest
    const candidates: { o: ElementNode; r: ElementNode; score: number }[] = []
    for (const o of origNodes) {
      if (pairs.some(([p]) => p === o)) continue
      for (const r of reproNodes) {
        if (usedRepro.has(r)) continue
        if (o.tag !== r.tag) continue
        const score = iou(o.box, r.box)
        if (score >= IOU_THRESHOLD) candidates.push({ o, r, score })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const usedOrig = new Set<ElementNode>(pairs.map(([o]) => o))
    for (const c of candidates) {
      if (usedOrig.has(c.o) || usedRepro.has(c.r)) continue
      usedOrig.add(c.o)
      usedRepro.add(c.r)
      pairs.push([c.o, c.r])
    }

    for (const o of origNodes) if (!usedOrig.has(o)) missing.push(o)
    for (const r of reproNodes) if (!usedRepro.has(r)) extra.push(r)

    // recurse into paired nodes
    for (const [o, r] of pairs.filter(([po]) => origNodes.includes(po))) {
      alignLevel(o.children, r.children)
    }
  }

  pairs.push([orig, repro])
  alignLevel(orig.children, repro.children)

  const total = countNodes(orig) + countNodes(repro)
  const unmatched = missing.reduce((s, n) => s + countNodes(n), 0) + extra.reduce((s, n) => s + countNodes(n), 0)
  return { pairs, missing, extra, failureRate: total ? unmatched / total : 0 }
}
