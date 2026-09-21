import { describe, expect, it } from 'vitest'
import type { ComputedStyles, ElementNode } from '@copypage/core'
import { comparePair, normalizeColor } from '../src/compare.js'

function styles(over: Partial<ComputedStyles>): ComputedStyles {
  return {
    fontFamily: 'Arial', fontSize: '16px', fontWeight: '400', lineHeight: '24px',
    color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none',
    borderRadius: '0px', boxShadow: 'none', border: '0px none rgb(0, 0, 0)',
    padding: '0px', margin: '0px', transform: 'none', opacity: '1', zIndex: 'auto',
    display: 'block', position: 'static',
    ...over,
  }
}

function node(w: number, h: number, s: ComputedStyles): ElementNode {
  return { id: '0/0', tag: 'button', selector: 'button.cta', box: { x: 0, y: 0, width: w, height: h }, styles: s, children: [] }
}

const PAGE_AREA = 1440 * 900

describe('normalizeColor extended', () => {
  it('parses oklch and converts to rgb channels', () => {
    // oklch red ≈ rgb(255, 0, 0)
    const c = normalizeColor('oklch(0.6279 0.2577 29.23)')
    expect(c).not.toBeNull()
    expect(c![0]).toBeGreaterThan(200)
    expect(c![1]).toBeLessThan(60)
    expect(c![2]).toBeLessThan(60)
  })
})

describe('comparePair px & border fixes', () => {
  it('oklch vs equivalent rgb does NOT false-positive', () => {
    const a = node(100, 40, styles({ color: 'oklch(0.6279 0.2577 29.23)' }))
    const b = node(100, 40, styles({ color: 'rgb(255, 0, 0)' }))
    const entries = comparePair(a, b, PAGE_AREA)
    expect(entries.find((x) => x.property === 'color')).toBeUndefined()
  })

  it('border color difference is reported', () => {
    const a = node(100, 40, styles({ border: '1px solid rgb(255, 0, 0)' }))
    const b = node(100, 40, styles({ border: '1px solid rgb(0, 0, 255)' }))
    const entries = comparePair(a, b, PAGE_AREA)
    expect(entries.find((x) => x.property === 'border')).toBeDefined()
  })

  it('fontSize 16px vs 17px IS reported (no 1px tolerance for non-geometry)', () => {
    const a = node(100, 40, styles({ fontSize: '16px' }))
    const b = node(100, 40, styles({ fontSize: '17px' }))
    const entries = comparePair(a, b, PAGE_AREA)
    expect(entries.find((x) => x.property === 'fontSize')).toBeDefined()
  })

  it('sub-0.1px rounding noise is still ignored', () => {
    const a = node(100, 40, styles({ fontSize: '16px' }))
    const b = node(100, 40, styles({ fontSize: '16.05px' }))
    const entries = comparePair(a, b, PAGE_AREA)
    expect(entries.find((x) => x.property === 'fontSize')).toBeUndefined()
  })
})
