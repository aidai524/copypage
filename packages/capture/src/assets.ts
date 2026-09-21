import type { Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface AssetsResult {
  files: string[]
  failed: { url: string; reason: string }[]
}

interface CollectedAsset {
  kind: 'url' | 'svg'
  url?: string
  svgSource?: string
  suggestedName: string
}

/** Collect + download page assets (img/src, favicon links, inline svg) into outDir/assets. */
export async function downloadAssets(page: Page, outDir: string): Promise<AssetsResult> {
  const assetsDir = path.join(outDir, 'assets')
  await mkdir(assetsDir, { recursive: true })

  const collected: CollectedAsset[] = await page.evaluate(`(() => {
    const out = []
    let i = 0
    for (const img of Array.from(document.querySelectorAll('img[src]'))) {
      const src = img.src
      if (!src || src.startsWith('data:')) continue
      const name = src.split('/').pop()?.split('?')[0] || 'img-' + i + '.png'
      out.push({ kind: 'url', url: src, suggestedName: (i++) + '-' + name })
    }
    for (const link of Array.from(document.querySelectorAll('link[rel~="icon"][href]'))) {
      const href = link.href
      if (!href || href.startsWith('data:')) continue
      const name = href.split('/').pop()?.split('?')[0] || 'favicon.ico'
      out.push({ kind: 'url', url: href, suggestedName: (i++) + '-' + name })
    }
    for (const svg of Array.from(document.querySelectorAll('svg'))) {
      out.push({ kind: 'svg', svgSource: svg.outerHTML, suggestedName: (i++) + '-icon.svg' })
    }
    // css background-image urls (hero banners etc. live here, not in img tags)
    const seen = new Set(out.map((a) => a.url).filter(Boolean))
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const bg = getComputedStyle(el).backgroundImage
      if (!bg || bg === 'none') continue
      for (const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) {
        const u = m[1]
        if (!u || u.startsWith('data:') || seen.has(u)) continue
        seen.add(u)
        const name = u.split('/').pop()?.split('?')[0] || 'bg-' + i + '.png'
        out.push({ kind: 'url', url: new URL(u, location.href).href, suggestedName: (i++) + '-' + name })
      }
    }
    return out
  })()`)

  const files: string[] = []
  const failed: { url: string; reason: string }[] = []

  for (const asset of collected) {
    const rel = path.join('assets', asset.suggestedName)
    if (asset.kind === 'svg') {
      await writeFile(path.join(outDir, rel), asset.svgSource!, 'utf8')
      files.push(rel)
      continue
    }
    try {
      const res = await page.request.get(asset.url!, {
        headers: { referer: page.url() },
        timeout: 15000,
      })
      if (!res.ok()) {
        failed.push({ url: asset.url!, reason: `http ${res.status()}` })
        continue
      }
      const body = await res.body()
      await writeFile(path.join(outDir, rel), body)
      files.push(rel)
    } catch (err) {
      failed.push({ url: asset.url!, reason: String(err).slice(0, 200) })
    }
  }

  return { files, failed }
}
