import { readFile, writeFile } from 'node:fs/promises'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { ssim } from 'ssim.js'

export interface PixelMetrics {
  ssim: number
  pixelDiffPct: number
  /** pixels trimmed from the taller image to allow comparison */
  trimmedDelta?: number
}

export type PixelResult = PixelMetrics | { layoutError: true }

const TRIM_TOLERANCE = 0.05

function trimPng(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png
  const out = new PNG({ width, height })
  PNG.bitblt(png, out, 0, 0, width, height, 0, 0)
  return out
}

/**
 * Compare two screenshots pixel-wise. Writes a heatmap (diff pixels in red,
 * original faded) to heatmapOut. Height mismatches within TRIM_TOLERANCE
 * are trimmed (common top area compared); larger mismatches → layoutError.
 */
export async function pixelDiff(aPath: string, bPath: string, heatmapOut: string): Promise<PixelResult> {
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
  const diffMask = new PNG({ width, height })
  const diffCount = pixelmatch(a.data, b.data, diffMask.data, width, height, {
    threshold: 0.1,
    diffColor: [255, 0, 0],
    alpha: 0.5, // blend non-diff pixels at 50% for readability
  })

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
    ...(trimmedDelta !== undefined ? { trimmedDelta } : {}),
  }
}
