import type { Page } from 'playwright'
import type { ElementNode } from '@copypage/core'

const MAX_NODES = 4000

/** Scroll to bottom in steps (triggering lazy loaders), then back to top. */
export async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8))
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 120))
    }
    window.scrollTo(0, 0)
    await new Promise((r) => setTimeout(r, 150))
  })
}

/**
 * Extract the visible DOM tree with computed styles.
 * Runs inside the page; returns the body-rooted ElementNode tree.
 */
export async function probeDom(page: Page): Promise<ElementNode> {
  return page.evaluate((maxNodes: number) => {
    const STYLE_PROPS = [
      'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color',
      'backgroundColor', 'backgroundImage', 'borderRadius', 'boxShadow', 'border',
      'padding', 'margin', 'transform', 'opacity', 'zIndex', 'display', 'position',
    ] as const

    let count = 0

    function buildSelector(el: Element): string {
      const idPart = el.id ? `#${el.id}` : ''
      const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('')
      let sel = el.tagName.toLowerCase() + idPart + cls
      if (!cls && !idPart && el.parentElement) {
        const sameTag = Array.from(el.parentElement.children).filter(
          (c) => c.tagName === el.tagName,
        )
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(el) + 1})`
      }
      return sel
    }

    function walk(el: Element, path: string): unknown {
      if (count >= maxNodes) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (cs.display === 'none' || cs.visibility === 'hidden') return null
      if (r.width < 1 || r.height < 1) return null
      count++

      const styles: Record<string, string> = {}
      for (const p of STYLE_PROPS) styles[p] = (cs as unknown as Record<string, string>)[p] ?? ''

      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 80)

      const children: unknown[] = []
      Array.from(el.children).forEach((child, i) => {
        const node = walk(child, `${path}/${i}`)
        if (node) children.push(node)
      })

      return {
        id: path,
        tag: el.tagName.toLowerCase(),
        selector: buildSelector(el),
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
        styles,
        ...(ownText ? { text: ownText } : {}),
        children,
      }
    }

    const root = walk(document.body, '0')
    if (!root) throw new Error('probe: body is not visible')
    return root
  }, MAX_NODES) as Promise<ElementNode>
}
