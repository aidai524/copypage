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

  it('pairs across wrapper divergence (React root div etc.)', () => {
    const a = node('0', 'body', { x: 0, y: 0, width: 1440, height: 6000 }, [
      node('0/0', 'nav', { x: 0, y: 48, width: 1440, height: 64 }),
      node('0/1', 'main', { x: 0, y: 48, width: 1440, height: 5900 }, [
        { ...node('0/1/0', 'h2', { x: 100, y: 4000, width: 693, height: 44 }), text: '创新故事' },
      ]),
    ])
    const b = node('0', 'body', { x: 0, y: 0, width: 1440, height: 6000 }, [
      node('0/0', 'div', { x: 0, y: 0, width: 1440, height: 6000 }, [
        node('0/0/0', 'nav', { x: 0, y: 48, width: 1440, height: 64 }),
        { ...node('0/0/1', 'h2', { x: 100, y: 3960, width: 693, height: 44 }), text: '创新故事' },
      ]),
    ])
    const r = alignTrees(a, b)
    const tags = r.pairs.map(([o]) => o.tag)
    expect(tags).toContain('nav')
    expect(tags).toContain('h2') // text + horizontal position rescue it across wrappers
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
