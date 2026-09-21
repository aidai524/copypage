import { describe, expect, it } from 'vitest'
import type { ElementNode } from '@copypage/core'
import { alignTrees } from '../src/align.js'

function node(
  id: string, tag: string, box: { x: number; y: number; width: number; height: number },
  children: ElementNode[] = [],
): ElementNode {
  return { id, tag, selector: tag, box, styles: {} as ElementNode['styles'], children }
}

describe('alignTrees', () => {
  it('pairs identical trees fully', () => {
    const make = (): ElementNode =>
      node('0', 'body', { x: 0, y: 0, width: 800, height: 600 }, [
        node('0/0', 'header', { x: 0, y: 0, width: 800, height: 60 }),
        node('0/1', 'button', { x: 100, y: 200, width: 160, height: 48 }),
      ])
    const r = alignTrees(make(), make())
    expect(r.pairs).toHaveLength(3)
    expect(r.missing).toHaveLength(0)
    expect(r.extra).toHaveLength(0)
    expect(r.failureRate).toBe(0)
  })

  it('moved element (IoU < 0.5) goes to missing/extra', () => {
    const a = node('0', 'body', { x: 0, y: 0, width: 800, height: 600 }, [
      node('0/0', 'button', { x: 100, y: 200, width: 160, height: 48 }),
    ])
    const b = node('0', 'body', { x: 0, y: 0, width: 800, height: 600 }, [
      node('0/0', 'button', { x: 500, y: 400, width: 160, height: 48 }),
    ])
    const r = alignTrees(a, b)
    // body pairs; button doesn't overlap → missing + extra
    expect(r.pairs).toHaveLength(1)
    expect(r.missing).toHaveLength(1)
    expect(r.extra).toHaveLength(1)
  })

  it('idMap forces pairing regardless of position', () => {
    const a = node('0', 'body', { x: 0, y: 0, width: 800, height: 600 }, [
      node('0/0', 'button', { x: 100, y: 200, width: 160, height: 48 }),
    ])
    const b = node('0', 'body', { x: 0, y: 0, width: 800, height: 600 }, [
      node('0/0', 'button', { x: 500, y: 400, width: 160, height: 48 }),
    ])
    const idMap = new Map([['0/0', '0/0']])
    const r = alignTrees(a, b, idMap)
    const buttonPair = r.pairs.find(([o]) => o.tag === 'button')
    expect(buttonPair).toBeDefined()
    expect(r.missing.filter((n) => n.tag === 'button')).toHaveLength(0)
  })
})
