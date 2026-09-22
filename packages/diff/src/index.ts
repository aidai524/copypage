import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readSnapshot, type DomSnapshot, type Snapshot } from '@copypage/core'
import { pixelDiff } from './pixel.js'
import { alignTrees } from './align.js'
import { comparePair, resetEntryCounter, type DiffEntry } from './compare.js'
import { cropPng, diffRegions } from './crops.js'

export interface DiffMetrics {
  ssim: number
  pixelDiffPct: number
}

export interface DiffResult {
  metrics: DiffMetrics
  entries: DiffEntry[]
}

export interface VlmRequest {
  id: string
  crop: string
  reproCrop: string
  prompt: string
}

async function readDom(dir: string, width: number): Promise<DomSnapshot | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'dom', `${width}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Full diff pipeline: per-viewport pixel layer; DOM layer when both sides
 * have DOM snapshots and alignment is healthy; otherwise crop regions into
 * a VLM request queue (vlm-requests.json). Writes diff.json.
 */
export async function diffSnapshots(
  origDir: string,
  reproDir: string,
  outDir: string,
  opts: { round?: number; idMap?: Map<string, string> } = {},
): Promise<DiffResult> {
  resetEntryCounter()
  await mkdir(outDir, { recursive: true })
  const orig: Snapshot = await readSnapshot(origDir)
  const repro: Snapshot = await readSnapshot(reproDir)

  const entries: DiffEntry[] = []
  const vlmRequests: VlmRequest[] = []
  let ssimSum = 0
  let ssimN = 0
  let pixelDiffPctMax = 0

  const viewports = orig.viewports.length ? orig.viewports : repro.viewports

  // visual-input orig (image/video) has screenshots keyed 'original' etc. that
  // never intersect the repro's viewport keys — handle as a virtual viewport.
  const keyOverlap = viewports.some(
    (w) => orig.screenshots[String(w)] && repro.screenshots[String(w)],
  )
  if (!keyOverlap && orig.input.type !== 'url') {
    const aShot = orig.screenshots['original'] ?? Object.values(orig.screenshots)[0]
    const bShot = Object.values(repro.screenshots)[0]
    if (aShot && bShot) {
      const heatRel = 'heatmap-visual.png'
      const res = await pixelDiff(path.join(origDir, aShot), path.join(reproDir, bShot), path.join(outDir, heatRel))
      if ('layoutError' in res) {
        // size mismatch: whole-pair VLM request + worst-case metrics
        entries.push({
          id: 'd-layout-visual',
          element: 'page',
          property: 'layout',
          expected: 'repro screenshot matches original image size',
          actual: 'size mismatch',
          severity: 100,
        })
        ssimSum += 0
        ssimN++
        pixelDiffPctMax = 100
        const cropRel = 'crops/visual-full-orig.png'
        const reproCropRel = 'crops/visual-full-repro.png'
        const { copyFile } = await import('node:fs/promises')
        await mkdir(path.join(outDir, 'crops'), { recursive: true })
        await copyFile(path.join(origDir, aShot), path.join(outDir, cropRel))
        await copyFile(path.join(reproDir, bShot), path.join(outDir, reproCropRel))
        vlmRequests.push({
          id: 'vlm-visual-full',
          crop: cropRel,
          reproCrop: reproCropRel,
          prompt:
            '对比这两张整页截图（orig=设计稿/原图, repro=还原页，尺寸不同请先对齐感受）。' +
            '列出布局与样式的所有可见差异，每条输出 JSON：' +
            '{"element": 描述, "property": css属性, "expected": "原图值", "actual": "还原值"}。只输出 JSON 数组。',
        })
      } else {
        ssimSum += res.ssim
        ssimN++
        pixelDiffPctMax = Math.max(pixelDiffPctMax, res.pixelDiffPct)
        const regions = await diffRegions(path.join(outDir, heatRel))
        for (let i = 0; i < Math.min(regions.length, 20); i++) {
          const rg = regions[i]
          const id = `vlm-visual-${i}`
          const cropRel = `crops/${id}-orig.png`
          const reproCropRel = `crops/${id}-repro.png`
          await cropPng(path.join(origDir, aShot), rg.bbox, path.join(outDir, cropRel))
          await cropPng(path.join(reproDir, bShot), rg.bbox, path.join(outDir, reproCropRel))
          vlmRequests.push({
            id,
            crop: cropRel,
            reproCrop: reproCropRel,
            prompt:
              '对比这两张同一区域的截图（orig=原图, repro=还原）。列出所有可见差异：' +
              '颜色、尺寸、间距、圆角、阴影、字体、缺失/多余元素。' +
              '每条输出 JSON：{"element": 描述, "property": css属性, "expected": "原图值", "actual": "还原值"}。只输出 JSON 数组。',
          })
        }
      }
    }
  }

  for (const width of viewports) {
    const aShot = orig.screenshots[String(width)]
    const bShot = repro.screenshots[String(width)]
    if (!aShot || !bShot) continue

    const heatRel = `heatmap-${width}.png`
    const res = await pixelDiff(path.join(origDir, aShot), path.join(reproDir, bShot), path.join(outDir, heatRel))

    let pixelOk = true
    if ('layoutError' in res) {
      pixelOk = false
      entries.push({
        id: `d-layout-${width}`,
        element: 'page',
        property: 'layout',
        expected: `screenshot ${width}px viewport sizes equal`,
        actual: 'size mismatch',
        severity: 100,
      })
      // layout-broken viewport must poison metrics — never let it pass silently
      ssimSum += 0
      ssimN++
      pixelDiffPctMax = 100
      // NOTE: no continue — DOM comparison below still tells us WHY sizes differ
    } else {
      ssimSum += res.ssim
      ssimN++
      pixelDiffPctMax = Math.max(pixelDiffPctMax, res.pixelDiffPct)
      if (res.trimmedDelta) {
        entries.push({
          id: `d-trim-${width}`,
          element: 'page',
          property: 'layout',
          expected: `screenshot heights equal`,
          actual: `height differs by ${res.trimmedDelta}px (trimmed for comparison)`,
          severity: 20,
        })
      }
    }

    // DOM layer
    const aDom = await readDom(origDir, width)
    const bDom = await readDom(reproDir, width)
    let usedDom = false
    if (aDom && bDom) {
      // Always run DOM comparison when both sides have DOM. Matched pairs are
      // high-precision (composite score >= 0.5); unmatched nodes become
      // presence entries (real clones legitimately lack hidden menus etc.).
      const alignment = alignTrees(aDom.root, bDom.root, opts.idMap)
      usedDom = true
      const pageArea = width * Math.max(aDom.root.box.height, bDom.root.box.height)
      for (const [o, r] of alignment.pairs) {
        entries.push(...comparePair(o, r, pageArea))
      }
      for (const m of alignment.missing) {
        if (m.box.width < 10 || m.box.height < 10) continue // hidden/a11y noise
        entries.push({
          id: `d-miss-${m.id}`,
          element: m.selector,
          property: 'presence',
          expected: m.text ? `present: "${m.text.slice(0, 40)}"` : `present (${Math.round(m.box.width)}x${Math.round(m.box.height)} @${Math.round(m.box.x)},${Math.round(m.box.y)})`,
          actual: 'missing in repro',
          severity: +(50 * (m.box.width * m.box.height) / pageArea).toFixed(1),
          evidence: { heatmapRegion: [m.box.x, m.box.y, m.box.width, m.box.height] },
        })
      }
    }

    // crop/VLM layer when DOM layer unavailable (needs same-size heatmap)
    if (!usedDom && pixelOk) {
      const regions = await diffRegions(path.join(outDir, heatRel))
      for (let i = 0; i < Math.min(regions.length, 20); i++) {
        const rg = regions[i]
        const id = `vlm-${width}-${i}`
        const cropRel = `crops/${id}-orig.png`
        const reproCropRel = `crops/${id}-repro.png`
        await cropPng(path.join(origDir, aShot), rg.bbox, path.join(outDir, cropRel))
        await cropPng(path.join(reproDir, bShot), rg.bbox, path.join(outDir, reproCropRel))
        vlmRequests.push({
          id,
          crop: cropRel,
          reproCrop: reproCropRel,
          prompt:
            '对比这两张同一区域的截图（orig=原站, repro=还原）。列出所有可见差异：' +
            '颜色、尺寸、间距、圆角、阴影、字体、缺失/多余元素。' +
            '每条输出 JSON：{"element": 描述, "property": css属性, "expected": "原站值", "actual": "还原值"}。只输出 JSON 数组。',
        })
      }
    }
  }

  const metrics: DiffMetrics = {
    ssim: ssimN ? +(ssimSum / ssimN).toFixed(4) : 0,
    pixelDiffPct: +pixelDiffPctMax.toFixed(2),
  }

  entries.sort((a, b) => b.severity - a.severity)
  const result: DiffResult = { metrics, entries: entries.slice(0, 50) }

  await writeFile(
    path.join(outDir, 'diff.json'),
    JSON.stringify({ round: opts.round ?? 1, metrics, entries: result.entries }, null, 2),
  )
  if (vlmRequests.length > 0) {
    await writeFile(path.join(outDir, 'vlm-requests.json'), JSON.stringify({ requests: vlmRequests }, null, 2))
  }
  return result
}
