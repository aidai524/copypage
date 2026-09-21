import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { writeSnapshot, type Snapshot } from '@copypage/core'
import { writeBriefScaffold } from './brief.js'

const MAX_EDGE = 4096

/**
 * Image input: copy original, generate 0.5x / 2x scale variants (edge-capped),
 * write snapshot.json. visual-brief scaffold is added by cli flow (brief.ts).
 */
export async function captureImage(file: string, outDir: string): Promise<void> {
  await mkdir(path.join(outDir, 'scales'), { recursive: true })
  const ext = path.extname(file).toLowerCase() || '.png'
  const origRel = `original${ext}`
  await copyFile(file, path.join(outDir, origRel))

  const meta = await sharp(file).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0

  async function scaled(factor: number, name: string) {
    let nw = Math.round(w * factor)
    let nh = Math.round(h * factor)
    const edge = Math.max(nw, nh)
    if (edge > MAX_EDGE) {
      const k = MAX_EDGE / edge
      nw = Math.round(nw * k)
      nh = Math.round(nh * k)
    }
    await sharp(file).resize(nw, nh).png().toFile(path.join(outDir, 'scales', name))
  }

  await scaled(0.5, '0.5x.png')
  await scaled(2, '2x.png')

  const snapshot: Snapshot = {
    input: { type: 'image', source: file },
    viewports: [w],
    screenshots: { original: origRel, '0.5x': 'scales/0.5x.png', '2x': 'scales/2x.png' },
  }
  await writeSnapshot(outDir, snapshot)
  await writeBriefScaffold(outDir, 'image')
}
