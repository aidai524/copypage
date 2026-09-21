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

describe('normalizeColor', () => {
  it('parses rgb/rgba/hex identically', () => {
    expect(normalizeColor('rgb(255, 0, 0)')).toEqual([255, 0, 0, 1])
    expect(normalizeColor('#ff0000')).toEqual([255, 0, 0, 1])
    expect(normalizeColor('rgba(99, 102, 241, 0.4)')).toEqual([99, 102, 241, 0.4])
  })
})

describe('comparePair', () => {
  it('reports border-radius 12px vs 8px', () => {
    const a = node(160, 48, styles({ borderRadius: '12px' }))
    const b = node(160, 48, styles({ borderRadius: '8px' }))
    const entries = comparePair(a, b, PAGE_AREA)
    const e = entries.find((x) => x.property === 'borderRadius')
    expect(e).toBeDefined()
    expect(e!.expected).toBe('12px')
    expect(e!.actual).toBe('8px')
    expect(e!.severity).toBeGreaterThan(0)
  })

  it('does NOT report rgb vs hex equivalent colors', () => {
    const a = node(160, 48, styles({ color: 'rgb(255, 0, 0)' }))
    const b = node(160, 48, styles({ color: '#ff0000' }))
    const entries = comparePair(a, b, PAGE_AREA)
    expect(entries.find((x) => x.property === 'color')).toBeUndefined()
  })

  it('reports missing box-shadow', () => {
    const a = node(160, 48, styles({ boxShadow: 'rgba(99, 102, 241, 0.4) 0px 4px 14px 0px' }))
    const b = node(160, 48, styles({ boxShadow: 'none' }))
    const entries = comparePair(a, b, PAGE_AREA)
    const e = entries.find((x) => x.property === 'boxShadow')
    expect(e).toBeDefined()
    expect(e!.actual).toBe('none')
  })

  it('larger area differences get higher severity', () => {
    const small = comparePair(node(10, 10, styles({ borderRadius: '12px' })), node(10, 10, styles({ borderRadius: '8px' })), PAGE_AREA)[0]
    const big = comparePair(node(800, 400, styles({ borderRadius: '12px' })), node(800, 400, styles({ borderRadius: '8px' })), PAGE_AREA)[0]
    expect(big.severity).toBeGreaterThan(small.severity)
  })

  it('geometry within 1px tolerance is not reported', () => {
    const a = node(160, 48, styles({}))
    const b: ElementNode = { ...node(160, 48, styles({})), box: { x: 0.4, y: 0, width: 160.5, height: 48 } }
    const entries = comparePair(a, b, PAGE_AREA)
    expect(entries.find((x) => x.property.startsWith('box.'))).toBeUndefined()
  })
})
