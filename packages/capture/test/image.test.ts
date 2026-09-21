import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { readSnapshot } from '@copypage/core'
import { captureImage } from '../src/image.js'

describe('captureImage', () => {
  let dir: string
  let src: string

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('copies original and writes scaled variants + snapshot', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-img-'))
    src = path.join(dir, 'input.png')
    await sharp({
      create: { width: 100, height: 60, channels: 3, background: { r: 99, g: 102, b: 241 } },
    }).png().toFile(src)

    const out = path.join(dir, 'snapshot')
    await captureImage(src, out)

    await access(path.join(out, 'original.png'))
    await access(path.join(out, 'scales', '0.5x.png'))
    await access(path.join(out, 'scales', '2x.png'))

    const meta2x = await sharp(path.join(out, 'scales', '2x.png')).metadata()
    expect(meta2x.width).toBe(200)
    expect(meta2x.height).toBe(120)

    const snap = await readSnapshot(out)
    expect(snap.input.type).toBe('image')
    expect(snap.screenshots['original']).toBe('original.png')
  })
})
