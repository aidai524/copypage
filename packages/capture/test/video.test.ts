import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, access, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readSnapshot } from '@copypage/core'
import { captureVideo } from '../src/video.js'

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasFfmpeg)('captureVideo', () => {
  let dir: string

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  function makeVideo(file: string, colorA: string, colorB: string, dur = 2) {
    execFileSync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', `color=${colorA}:duration=${dur / 2}:size=320x240:rate=10`,
      '-f', 'lavfi', '-i', `color=${colorB}:duration=${dur / 2}:size=320x240:rate=10`,
      '-filter_complex', 'concat=n=2:v=1',
      '-pix_fmt', 'yuv420p', file,
    ], { stdio: 'ignore' })
  }

  it('extracts frames incl. scene-change timestamp, capped at maxFrames', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-vid-'))
    const video = path.join(dir, 'test.mp4')
    makeVideo(video, 'blue', 'red')
    const out = path.join(dir, 'snapshot')
    await captureVideo(video, out, { maxFrames: 8 })

    const files = await readdir(path.join(out, 'frames'))
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.length).toBeLessThanOrEqual(8)

    const snap = await readSnapshot(out)
    expect(snap.input.type).toBe('video')
    const times = snap.frames!.map((f) => f.t)
    // scene change at ~1s must be represented
    expect(times.some((t) => Math.abs(t - 1) <= 0.5)).toBe(true)
    for (const f of snap.frames!) await access(path.join(out, f.file))
  }, 60000)

  it('falls back to uniform sampling when there is no scene change', async () => {
    const dir2 = await mkdtemp(path.join(tmpdir(), 'cp-vid2-'))
    try {
      const video = path.join(dir2, 'flat.mp4')
      makeVideo(video, 'green', 'green')
      const out = path.join(dir2, 'snapshot')
      await captureVideo(video, out, { maxFrames: 10 })
      const snap = await readSnapshot(out)
      expect(snap.frames!.length).toBeGreaterThanOrEqual(3)
      expect(snap.frames!.length).toBeLessThanOrEqual(10)
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }
  }, 60000)
})
