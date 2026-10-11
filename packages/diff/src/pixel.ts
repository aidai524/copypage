import { readFile, writeFile } from 'node:fs/promises'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { ssim } from 'ssim.js'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PixelMetrics {
  ssim: number
  pixelDiffPct: number
  /** pixels trimmed from the taller image to allow comparison */
  trimmedDelta?: number
  /** share of the viewport excluded as dynamic (live) content */
  dynamicAreaPct?: number
}

export type PixelResult = PixelMetrics | { layoutError: true }

export interface PixelDiffOptions {
  /** rectangles excluded from comparison (live/dynamic regions) */
  masks?: Rect[]
}

const TRIM_TOLERANCE = 0.05
const MASK_FILL: [number, number, number] = [19, 19, 22] // page background

function trimPng(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png
  const out = new PNG({ width, height })
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0)
  return out
}

/** Paint mask rects over the image with the page background colour. */
function applyMasks(png: PNG, masks: Rect[]): number {
  if (masks.length === 0) return 0
  const seen = new Uint8Array(png.width * png.height)
  let masked = 0
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x))
    const y0 = Math.max(0, Math.floor(m.y))
    const x1 = Math.min(png.width, Math.ceil(m.x + m.width))
    const y1 = Math.min(png.height, Math.ceil(m.y + m.height))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * png.width + x
        if (seen[p]) continue
        seen[p] = 1
        masked++
        const i = p * 4
        png.data[i] = MASK_FILL[0]
        png.data[i + 1] = MASK_FILL[1]
        png.data[i + 2] = MASK_FILL[2]
        png.data[i + 3] = 255
      }
    }
  }
  return masked
}

/** Tint masked rects blue on the heatmap so reviewers see what was excluded. */
function tintMasks(png: PNG, masks: Rect[]): void {
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x))
    const y0 = Math.max(0, Math.floor(m.y))
    const x1 = Math.min(png.width, Math.ceil(m.x + m.width))
    const y1 = Math.min(png.height, Math.ceil(m.y + m.height))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4
        png.data[i] = Math.round(png.data[i] * 0.75 + 59 * 0.25)
        png.data[i + 1] = Math.round(png.data[i + 1] * 0.75 + 130 * 0.25)
        png.data[i + 2] = Math.round(png.data[i + 2] * 0.75 + 246 * 0.25)
      }
    }
  }
}

/**
 * Compare two screenshots pixel-wise. Writes a heatmap (diff pixels in red,
 * original faded, dynamic regions tinted blue) to heatmapOut. Height
 * mismatches within TRIM_TOLERANCE are trimmed (common top area compared);
 * larger mismatches → layoutError.
 *
 * Masks exclude live/dynamic regions (see capture detectDynamicRegions):
 * live data cannot be reproduced from a snapshot, so it must not poison
 * layout/style convergence.
 */
export async function pixelDiff(
  aPath: string,
  bPath: string,
  heatmapOut: string,
  opts: PixelDiffOptions = {},
): Promise<PixelResult> {
  const masks = opts.masks ?? []
  const [aBuf, bBuf] = await Promise.all([readFile(aPath), readFile(bPath)])
  let a = PNG.sync.read(aBuf)
  let b = PNG.sync.read(bBuf)

  let trimmedDelta: number | undefined
  if (a.width !== b.width || a.height !== b.height) {
    const dw = Math.abs(a.width - b.width)
    const dh = Math.abs(a.height - b.height)
    if (dw > 0 || dh > Math.min(a.height, b.height) * TRIM_TOLERANCE) {
      return { layoutError: true }
    }
    const h = Math.min(a.height, b.height)
    a = trimPng(a, a.width, h)
    b = trimPng(b, b.width, h)
    trimmedDelta = dh
  }

  const { width, height } = a
  let maskedPixels = 0
  if (masks.length > 0) {
    maskedPixels = applyMasks(a, masks)
    applyMasks(b, masks)
  }
  const dynamicAreaPct = masks.length > 0 ? +((maskedPixels / (width * height)) * 100).toFixed(2) : undefined

  const diffMask = new PNG({ width, height })
  const diffCount = pixelmatch(a.data, b.data, diffMask.data, width, height, {
    threshold: 0.1,
    diffColor: [255, 0, 0],
    alpha: 0.5, // blend non-diff pixels at 50% for readability
  })
  tintMasks(diffMask, masks)

  await writeFile(heatmapOut, PNG.sync.write(diffMask))

  const toImageData = (png: PNG) => ({
    data: new Uint8ClampedArray(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length)),
    width: png.width,
    height: png.height,
    colorSpace: 'srgb' as const,
  })
  const { mssim } = ssim(toImageData(a), toImageData(b))

  return {
    ssim: mssim,
    pixelDiffPct: +((diffCount / (width * height)) * 100).toFixed(2),
    ...(dynamicAreaPct !== undefined ? { dynamicAreaPct } : {}),
    ...(trimmedDelta !== undefined ? { trimmedDelta } : {}),
  }
}
