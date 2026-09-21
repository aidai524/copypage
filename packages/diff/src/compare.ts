import type { ElementNode } from '@copypage/core'
import { parse, converter } from 'culori'

const toRgb = converter('rgb')

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
const PX_TOLERANCE = 0.1
const COLOR_CHANNEL_TOLERANCE = 4

/** Parse any css color (rgb/hex/oklch/lab/color()…) into [r,g,b,a] 0-255 channels. */
export function normalizeColor(s: string): [number, number, number, number] | null {
  const parsed = parse(s.trim())
  if (!parsed) return null
  const rgb = toRgb(parsed)
  if (!rgb) return null
  const { r, g, b } = rgb as { r: number; g: number; b: number }
  if ([r, g, b].some((v) => Number.isNaN(v))) return null
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), +(rgb.alpha ?? 1).toFixed(3)]
}

/** colors embedded anywhere in a css value string (border, box-shadow, …) */
function extractColors(s: string): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  for (const m of s.matchAll(/rgba?\([^)]+\)|oklch\([^)]+\)|lab\([^)]+\)|#[0-9a-fA-F]{3,8}\b/g)) {
    const c = normalizeColor(m[0])
    if (c) out.push(c)
  }
  return out
}

function colorsClose(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return Math.max(
    Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 255,
  ) <= COLOR_CHANNEL_TOLERANCE
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
      if (maxD <= PX_TOLERANCE) {
        // px values match — but embedded colors may differ (border, shadows)
        const ec2 = extractColors(e)
        const ac2 = extractColors(a)
        const colorDiff =
          ec2.length !== ac2.length || ec2.some((c, i) => !colorsClose(c, ac2[i]))
        if (!colorDiff) continue
        entries.push(entry(orig, key, e, a, pageArea, 0.3))
        continue
      }
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
