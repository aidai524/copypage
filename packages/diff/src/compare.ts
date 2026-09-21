import type { ElementNode } from '@copypage/core'

export interface DiffEntry {
  id: string
  /** source file of the repro component, when known via id map */
  component?: string
  /** css-ish selector of the element */
  element: string
  property: string
  expected: string
  actual: string
  severity: number
  evidence?: { crop?: string; heatmapRegion?: [number, number, number, number] }
}

const GEOMETRY_TOLERANCE_PX = 1
const COLOR_CHANNEL_TOLERANCE = 4

/** Parse css color (rgb/rgba/hex) into [r,g,b,a]. Returns null when unparsable. */
export function normalizeColor(s: string): [number, number, number, number] | null {
  const str = s.trim().toLowerCase()
  const rgb = str.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] === undefined ? 1 : +rgb[4]]
  const hex = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/)
  if (hex) {
    let h = hex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    return [r, g, b, +a.toFixed(3)]
  }
  return null
}

function parsePxList(s: string): number[] | null {
  const m = s.match(/-?\d+(?:\.\d+)?px/g)
  return m ? m.map((v) => parseFloat(v)) : null
}

function severityFor(box: { width: number; height: number }, pageArea: number, deviation: number): number {
  const areaShare = (box.width * box.height) / pageArea
  return +(100 * areaShare * Math.min(1, deviation)).toFixed(1)
}

let entryCounter = 0

function entry(
  el: ElementNode,
  property: string,
  expected: string,
  actual: string,
  pageArea: number,
  deviation: number,
): DiffEntry {
  return {
    id: `d-${String(++entryCounter).padStart(3, '0')}`,
    element: el.selector,
    property,
    expected,
    actual,
    severity: severityFor(el.box, pageArea, deviation),
  }
}

/** Compare one aligned pair of elements; returns property-level diff entries. */
export function comparePair(orig: ElementNode, repro: ElementNode, pageArea: number): DiffEntry[] {
  const entries: DiffEntry[] = []

  // geometry
  const geo: [keyof ElementNode['box'], number, number][] = [
    ['x', orig.box.x, repro.box.x],
    ['y', orig.box.y, repro.box.y],
    ['width', orig.box.width, repro.box.width],
    ['height', orig.box.height, repro.box.height],
  ]
  for (const [k, e, a] of geo) {
    const d = Math.abs(e - a)
    if (d > GEOMETRY_TOLERANCE_PX) {
      entries.push(entry(orig, `box.${k}`, String(e), String(a), pageArea, d / Math.max(10, Math.abs(e))))
    }
  }

  // style properties
  const keys = Object.keys(orig.styles) as (keyof ElementNode['styles'])[]
  for (const key of keys) {
    const e = orig.styles[key] ?? ''
    const a = repro.styles[key] ?? ''
    if (e === a) continue

    // color-ish
    if (['color', 'backgroundColor'].includes(key)) {
      const ec = normalizeColor(e)
      const ac = normalizeColor(a)
      if (ec && ac) {
        const maxCh = Math.max(
          Math.abs(ec[0] - ac[0]), Math.abs(ec[1] - ac[1]),
          Math.abs(ec[2] - ac[2]), Math.abs(ec[3] - ac[3]) * 255,
        )
        if (maxCh <= COLOR_CHANNEL_TOLERANCE) continue
        entries.push(entry(orig, key, e, a, pageArea, maxCh / 255))
        continue
      }
    }

    // px-list properties (borderRadius, padding, margin, fontSize, lineHeight, border)
    const ep = parsePxList(e)
    const ap = parsePxList(a)
    if (ep && ap && ep.length === ap.length) {
      const maxD = Math.max(...ep.map((v, i) => Math.abs(v - ap[i])))
      if (maxD <= GEOMETRY_TOLERANCE_PX) continue
      entries.push(entry(orig, key, e, a, pageArea, maxD / Math.max(10, ...ep.map(Math.abs))))
      continue
    }

    // opacity numeric
    if (key === 'opacity') {
      const d = Math.abs(parseFloat(e) - parseFloat(a))
      if (d < 0.02) continue
      entries.push(entry(orig, key, e, a, pageArea, d))
      continue
    }

    // normalized string compare for the rest (boxShadow, transform, fonts…)
    if (e.replace(/\s+/g, ' ').trim() === a.replace(/\s+/g, ' ').trim()) continue
    entries.push(entry(orig, key, e, a, pageArea, 1))
  }

  return entries
}

/** Reset the entry id counter (per diff run). */
export function resetEntryCounter(): void {
  entryCounter = 0
}
