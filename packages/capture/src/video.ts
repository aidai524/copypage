import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { writeSnapshot, type Snapshot, type VideoFrame } from '@copypage/core'
import { writeBriefScaffold } from './brief.js'

const run = promisify(execFile)

export interface CaptureVideoOptions {
  maxFrames?: number
  /** scene-change sensitivity 0..1, lower = more sensitive */
  sceneThreshold?: number
  /** uniform sampling rate */
  fps?: number
}

const DEFAULT_MAX_FRAMES = 200

async function ffmpegAvailable(): Promise<void> {
  try {
    await run('ffmpeg', ['-version'])
  } catch {
    throw new Error('ffmpeg not found. Install with: brew install ffmpeg')
  }
}

async function probeDuration(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ])
  return parseFloat(stdout.trim()) || 0
}

/** scene-change timestamps via select + showinfo */
async function sceneTimes(file: string, threshold: number): Promise<number[]> {
  try {
    const { stderr } = await run('ffmpeg', [
      '-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-',
    ])
    const times: number[] = []
    for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) times.push(parseFloat(m[1]))
    return times
  } catch {
    return []
  }
}

/** Extract a single frame at time t to out path. */
async function grabFrame(file: string, t: number, out: string): Promise<void> {
  await run('ffmpeg', ['-y', '-ss', String(t), '-i', file, '-frames:v', '1', out])
}

/**
 * Video input: scene-change detection + uniform sampling, merged, deduped,
 * sorted, thinned to maxFrames. Writes frames/ + snapshot.json.
 */
export async function captureVideo(
  file: string,
  outDir: string,
  opts: CaptureVideoOptions = {},
): Promise<void> {
  await ffmpegAvailable()
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES
  const sceneThreshold = opts.sceneThreshold ?? 0.35
  const fps = opts.fps ?? 4

  const duration = await probeDuration(file)
  const scenes = await sceneTimes(file, sceneThreshold)

  // uniform sample points
  const uniform: number[] = []
  if (duration > 0) {
    const step = 1 / fps
    for (let t = 0; t < duration; t += step) uniform.push(+t.toFixed(3))
  }

  // merge + dedupe within 0.25s, always keep t=0 and last moment
  const merged = [...new Set([0, ...scenes, ...uniform, Math.max(0, duration - 0.1)])]
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.05)

  // thin to maxFrames uniformly if over cap
  let picked = merged
  if (picked.length > maxFrames) {
    const sceneSet = new Set(scenes)
    const nonScene = picked.filter((t) => !sceneSet.has(t))
    const keepNonScene = Math.max(0, maxFrames - scenes.length)
    const step = nonScene.length / keepNonScene || 1
    const thinned: number[] = []
    for (let i = 0; i < nonScene.length && thinned.length < keepNonScene; i += step) {
      thinned.push(nonScene[Math.floor(i)])
    }
    picked = [...new Set([...scenes, ...thinned])].sort((a, b) => a - b).slice(0, maxFrames)
  }

  const framesDir = path.join(outDir, 'frames')
  await mkdir(framesDir, { recursive: true })

  const frames: VideoFrame[] = []
  for (let i = 0; i < picked.length; i++) {
    const name = `frames/${String(i).padStart(4, '0')}.png`
    await grabFrame(file, picked[i], path.join(outDir, name))
    frames.push({ file: name, t: picked[i] })
  }

  const snapshot: Snapshot = {
    input: { type: 'video', source: file },
    viewports: [],
    screenshots: {},
    frames,
  }
  await writeSnapshot(outDir, snapshot)
  await writeBriefScaffold(outDir, 'video')
}
