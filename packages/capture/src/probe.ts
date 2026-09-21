import type { Page } from 'playwright'
import type { ElementNode } from '@copypage/core'

const MAX_NODES = 4000

/** Scroll to bottom in steps (triggering lazy loaders), then back to top. */
export async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(`(async () => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8))
    for (let y = 0; y <= document.body.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 120))
    }
    window.scrollTo(0, 0)
    await new Promise((r) => setTimeout(r, 150))
  })()`)
}

/**
 * Page-side probe source. Kept as a STRING so serialization into the browser
 * is unaffected by TS transpilation helpers (e.g. esbuild keepNames __name).
 */
const PROBE_SRC = `(maxNodes) => {
  const STYLE_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color',
    'backgroundColor', 'backgroundImage', 'borderRadius', 'boxShadow', 'border',
    'padding', 'margin', 'transform', 'opacity', 'zIndex', 'display', 'position',
  ]

  let count = 0

  function buildSelector(el) {
    const idPart = el.id ? '#' + el.id : ''
    const cls = Array.from(el.classList).slice(0, 2).map((c) => '.' + c).join('')
    let sel = el.tagName.toLowerCase() + idPart + cls
    if (!cls && !idPart && el.parentElement) {
      const sameTag = Array.from(el.parentElement.children).filter(
        (c) => c.tagName === el.tagName,
      )
      if (sameTag.length > 1) sel += ':nth-of-type(' + (sameTag.indexOf(el) + 1) + ')'
    }
    return sel
  }

  function walk(el, path) {
    if (count >= maxNodes) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (cs.display === 'none' || cs.visibility === 'hidden') return null
    if (r.width < 1 || r.height < 1) return null
    count++

    const styles = {}
    for (const p of STYLE_PROPS) styles[p] = cs[p] ?? ''

    const ownText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent ?? '').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 80)

    const children = []
    Array.from(el.children).forEach((child, i) => {
      const node = walk(child, path + '/' + i)
      if (node) children.push(node)
    })

    const attrs = {}
    if (el.tagName === 'IMG' && el.src) attrs.src = el.src
    if (el.tagName === 'A' && el.href) attrs.href = el.href
    if (el.tagName === 'VIDEO') {
      if (el.src) attrs.src = el.src
      if (el.poster) attrs.poster = el.poster
    }

    return {
      id: path,
      tag: el.tagName.toLowerCase(),
      selector: buildSelector(el),
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      styles,
      ...(ownText ? { text: ownText } : {}),
      ...(Object.keys(attrs).length ? { attrs } : {}),
      children,
    }
  }

  const root = walk(document.body, '0')
  if (!root) throw new Error('probe: body is not visible')
  return root
}`

/**
 * Extract the visible DOM tree with computed styles.
 * Returns the body-rooted ElementNode tree.
 */
export async function probeDom(page: Page): Promise<ElementNode> {
  return page.evaluate(`(${PROBE_SRC})(${MAX_NODES})`) as Promise<ElementNode>
}
