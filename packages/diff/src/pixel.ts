import { readFile, writeFile } from 'node:fs/promises'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { ssim } from 'ssim.js'

export interface PixelMetrics {
  ssim: number
  pixelDiffPct: number
}

export type PixelResult = PixelMetrics | { layoutError: true }

/**
 * Compare two screenshots pixel-wise. Writes a heatmap (diff pixels in red,
 * original faded) to heatmapOut. Returns layoutError when sizes differ.
 */
export async function pixelDiff(aPath: string, bPath: string, heatmapOut: string): Promise<PixelResult> {
  const [aBuf, bBuf] = await Promise.all([readFile(aPath), readFile(bPath)])
  const a = PNG.sync.read(aBuf)
  const b = PNG.sync.read(bBuf)

  if (a.width !== b.width || a.height !== b.height) {
    return { layoutError: true }
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
  }
}
