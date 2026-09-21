import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'

export interface CropRegion {
  /** [x, y, w, h] in source image coordinates */
  bbox: [number, number, number, number]
  diffPixels: number
}

const CELL = 32
const CELL_DIFF_RATIO = 0.05
const PADDING = 20

/**
 * Find diff regions on a pixelmatch heatmap (red-marked diff pixels),
 * cluster them on a coarse grid, and return padded bboxes.
 */
export async function diffRegions(heatmapPath: string): Promise<CropRegion[]> {
  const png = PNG.sync.read(await readFile(heatmapPath))
  const { width, height, data } = png

  const cols = Math.ceil(width / CELL)
  const rows = Math.ceil(height / CELL)
  const cellDiff = new Float64Array(cols * rows)
  const cellSize = new Float64Array(cols * rows)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const isDiff = data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80
      const c = Math.floor(y / CELL) * cols + Math.floor(x / CELL)
      cellSize[c]++
      if (isDiff) cellDiff[c]++
    }
  }

  const hot = new Set<number>()
  for (let c = 0; c < cellDiff.length; c++) {
    if (cellSize[c] > 0 && cellDiff[c] / cellSize[c] > CELL_DIFF_RATIO) hot.add(c)
  }

  // BFS cluster hot cells (4-connectivity)
  const seen = new Set<number>()
  const regions: CropRegion[] = []
  for (const start of hot) {
    if (seen.has(start)) continue
    const queue = [start]
    seen.add(start)
    let minC = Infinity, maxC = -1, minR = Infinity, maxR = -1, pixels = 0
    while (queue.length) {
      const c = queue.pop()!
      const cr = Math.floor(c / cols)
      const cc = c % cols
      minR = Math.min(minR, cr); maxR = Math.max(maxR, cr)
      minC = Math.min(minC, cc); maxC = Math.max(maxC, cc)
      pixels += cellDiff[c]
      for (const n of [c - 1, c + 1, c - cols, c + cols]) {
        const nr = Math.floor(n / cols)
        const nc = n % cols
        if (n < 0 || n >= cellDiff.length || nc < 0 || nc >= cols) continue
        if (Math.abs(nr - cr) + Math.abs(nc - cc) !== 1) continue
        if (hot.has(n) && !seen.has(n)) {
          seen.add(n)
          queue.push(n)
        }
      }
    }
    const x = Math.max(0, minC * CELL - PADDING)
    const y = Math.max(0, minR * CELL - PADDING)
    const w = Math.min(width - x, (maxC - minC + 1) * CELL + PADDING * 2)
    const h = Math.min(height - y, (maxR - minR + 1) * CELL + PADDING * 2)
    regions.push({ bbox: [x, y, w, h], diffPixels: pixels })
  }

  return regions.sort((a, b) => b.diffPixels - a.diffPixels)
}

/** Crop a PNG to bbox, write to out path. */
export async function cropPng(srcPath: string, bbox: [number, number, number, number], outPath: string): Promise<void> {
  const png = PNG.sync.read(await readFile(srcPath))
  const [x, y, w, h] = bbox
  const out = new PNG({ width: w, height: h })
  PNG.bitblt(png, out, x, y, w, h, 0, 0)
  await mkdir(path.dirname(outPath), { recursive: true })
  await writeFile(outPath, PNG.sync.write(out))
}
