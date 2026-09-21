import type { ElementNode } from './types.js'
export type { ElementNode }

/** Find a node by its path id ("0/2/1"). */
export function queryRegion(root: ElementNode, regionId: string): ElementNode | undefined {
  if (root.id === regionId) return root
  for (const c of root.children) {
    const hit = queryRegion(c, regionId)
    if (hit) return hit
  }
  return undefined
}

/**
 * Simplified selector match: "tag", ".class", "tag.class", "#id".
 * Matches against the node's tag and selector string.
 */
export function querySelector(root: ElementNode, cssLike: string): ElementNode[] {
  const out: ElementNode[] = []
  const tag = cssLike.match(/^[a-z][a-z0-9]*/i)?.[0]?.toLowerCase()
  const cls = cssLike.match(/\.[a-z0-9_-]+/gi)?.map((s) => s.slice(1)) ?? []
  const id = cssLike.match(/#[a-z0-9_-]+/i)?.[0]?.slice(1)

  function visit(n: ElementNode) {
    const tagOk = !tag || n.tag === tag
    const clsOk = cls.every((c) => n.selector.includes('.' + c))
    const idOk = !id || n.selector.includes('#' + id)
    if (tagOk && clsOk && idOk && (tag || cls.length || id)) out.push(n)
    for (const c of n.children) visit(c)
  }
  visit(root)
  return out
}

// CLI: tsx packages/core/src/query.ts <snapshotDir> --viewport 1440 (--region 0/1/0 | --selector button.cta)
if (process.argv[1]?.endsWith('query.ts')) {
  const { readFile } = await import('node:fs/promises')
  const path = await import('node:path')
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? process.argv[i + 1] : undefined
  }
  const dir = process.argv[2]
  const viewport = arg('viewport')
  const region = arg('region')
  const selector = arg('selector')
  if (!dir || !viewport || (!region && !selector)) {
    console.error('usage: query.ts <snapshotDir> --viewport <w> --region <id> | --selector <css>')
    process.exit(1)
  }
  const dom = JSON.parse(await readFile(path.join(dir, 'dom', `${viewport}.json`), 'utf8'))
  const result = region ? queryRegion(dom.root, region) : querySelector(dom.root, selector!)
  console.log(JSON.stringify(result, null, 2))
}
