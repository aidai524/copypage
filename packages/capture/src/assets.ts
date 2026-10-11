import type { Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface AssetsResult {
  files: string[]
  failed: { url: string; reason: string }[]
}

export interface DownloadAssetsOptions {
  /** hard wall-clock budget for the whole phase; remaining assets are marked failed */
  budgetMs?: number
  /** hard per-asset wall-clock budget including body streaming */
  perAssetMs?: number
  concurrency?: number
}

interface CollectedAsset {
  kind: 'url' | 'svg'
  url?: string
  svgSource?: string
  suggestedName: string
}

const EXT_BY_CTYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'video/mp4': '.mp4',
}

/** Append/repair the file extension based on the served content-type. */
export function withContentTypeExt(name: string, contentType: string | undefined): string {
  const ctype = (contentType ?? '').split(';')[0].trim().toLowerCase()
  const wanted = EXT_BY_CTYPE[ctype]
  if (!wanted) return name
  const current = path.extname(name).toLowerCase()
  if (current === wanted) return name
  return `${name.replace(/\.[a-z0-9]+$/i, '')}${wanted}`
}

/** Collect + download page assets (img/src, favicon links, inline svg) into outDir/assets. */
export async function downloadAssets(
  page: Page,
  outDir: string,
  opts: DownloadAssetsOptions = {},
): Promise<AssetsResult> {
  const budgetMs = opts.budgetMs ?? 120_000
  const perAssetMs = opts.perAssetMs ?? 12_000
  const deadline = Date.now() + budgetMs
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
  const MAX_ASSET_BYTES = 10 * 1024 * 1024

  async function fetchOne(asset: CollectedAsset): Promise<void> {
    const rel = path.join('assets', asset.suggestedName)
    if (asset.kind === 'svg') {
      await writeFile(path.join(outDir, rel), asset.svgSource!, 'utf8')
      files.push(rel)
      return
    }
    if (Date.now() > deadline) {
      failed.push({ url: asset.url!, reason: 'assets budget exceeded' })
      return
    }
    try {
      // page.request timeout only covers response headers; a throttled body
      // stream can hang forever, so race the whole read with a hard timer
      const { buf: body, ctype } = await new Promise<{ buf: Buffer; ctype: string | undefined }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`asset timed out after ${perAssetMs}ms`)), perAssetMs)
        void (async () => {
          try {
            const res = await page.request.get(asset.url!, {
              headers: { referer: page.url() },
              timeout: perAssetMs,
            })
            if (!res.ok()) {
              clearTimeout(timer)
              reject(new Error(`http ${res.status()}`))
              return
            }
            const len = Number(res.headers()['content-length'] ?? '0')
            if (len > MAX_ASSET_BYTES) {
              clearTimeout(timer)
              reject(new Error(`too large (${Math.round(len / 1024 / 1024)}MB)`))
              return
            }
            const buf = await res.body()
            clearTimeout(timer)
            resolve({ buf, ctype: res.headers()['content-type'] })
          } catch (err) {
            clearTimeout(timer)
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        })()
      })
      if (body.length > MAX_ASSET_BYTES) {
        failed.push({ url: asset.url!, reason: `too large (${Math.round(body.length / 1024 / 1024)}MB)` })
        return
      }
      // pump.fun-style proxies serve extension-less URLs; repair from content-type
      const finalName = withContentTypeExt(asset.suggestedName, ctype)
      const finalRel = path.join('assets', finalName)
      await writeFile(path.join(outDir, finalRel), body)
      files.push(finalRel)
    } catch (err) {
      failed.push({ url: asset.url!, reason: String(err instanceof Error ? err.message : err).slice(0, 200) })
    }
  }

  // bounded concurrency: IPFS-hosted images can take seconds each, and 200+
  // assets serialized turn a capture into a multi-minute stall
  const CONCURRENCY = opts.concurrency ?? 8
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, collected.length) }, async () => {
      while (cursor < collected.length) {
        const asset = collected[cursor++]
        await fetchOne(asset)
      }
    }),
  )

  return { files, failed }
}
