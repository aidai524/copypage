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

  for (const width of viewports) {
    const aShot = orig.screenshots[String(width)]
    const bShot = repro.screenshots[String(width)]
    if (!aShot || !bShot) continue

    const heatRel = `heatmap-${width}.png`
    const res = await pixelDiff(path.join(origDir, aShot), path.join(reproDir, bShot), path.join(outDir, heatRel))

    if ('layoutError' in res) {
      entries.push({
        id: `d-layout-${width}`,
        element: 'page',
        property: 'layout',
        expected: `screenshot ${width}px viewport sizes equal`,
        actual: 'size mismatch',
        severity: 100,
      })
      continue
    }

    ssimSum += res.ssim
    ssimN++
    pixelDiffPctMax = Math.max(pixelDiffPctMax, res.pixelDiffPct)

    // DOM layer
    const aDom = await readDom(origDir, width)
    const bDom = await readDom(reproDir, width)
    let usedDom = false
    if (aDom && bDom) {
      const alignment = alignTrees(aDom.root, bDom.root, opts.idMap)
      if (alignment.failureRate <= 0.3) {
        usedDom = true
        const pageArea = width * Math.max(aDom.root.box.height, bDom.root.box.height)
        for (const [o, r] of alignment.pairs) {
          entries.push(...comparePair(o, r, pageArea))
        }
        for (const m of alignment.missing) {
          entries.push({
            id: `d-miss-${m.id}`,
            element: m.selector,
            property: 'presence',
            expected: 'present',
            actual: 'missing in repro',
            severity: 50,
            evidence: { heatmapRegion: [m.box.x, m.box.y, m.box.width, m.box.height] },
          })
        }
      }
    }

    // crop/VLM layer when DOM layer unavailable
    if (!usedDom) {
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
