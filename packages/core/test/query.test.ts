import { describe, expect, it } from 'vitest'
import { queryRegion, querySelector, type ElementNode } from '../src/query.js'

function node(id: string, tag: string, selector: string, children: ElementNode[] = []): ElementNode {
  return {
    id, tag, selector,
    box: { x: 0, y: 0, width: 100, height: 50 },
    styles: {} as ElementNode['styles'],
    children,
  }
}

const tree = node('0', 'body', 'body', [
  node('0/0', 'header', 'header', [node('0/0/0', 'div', 'div.logo')]),
  node('0/1', 'section', 'section.hero', [
    node('0/1/0', 'button', 'button.cta'),
    node('0/1/1', 'button', 'button.secondary'),
  ]),
])

describe('snapshot query', () => {
  it('queryRegion finds by path id', () => {
    const hit = queryRegion(tree, '0/1/0')
    expect(hit?.selector).toBe('button.cta')
    expect(queryRegion(tree, '0/9/9')).toBeUndefined()
  })

  it('querySelector matches tag and class', () => {
    const buttons = querySelector(tree, 'button')
    expect(buttons).toHaveLength(2)
    const cta = querySelector(tree, 'button.cta')
    expect(cta).toHaveLength(1)
    expect(cta[0].id).toBe('0/1/0')
  })
})
