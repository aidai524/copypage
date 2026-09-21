import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Snapshot } from './types.js'

function assertValidSnapshot(s: unknown): asserts s is Snapshot {
  const o = s as Snapshot
  if (!o || typeof o !== 'object') throw new Error('invalid snapshot: not an object')
  if (!o.input || typeof o.input !== 'object') throw new Error('invalid snapshot: missing input')
  if (!['url', 'image', 'video'].includes(o.input.type))
    throw new Error(`invalid snapshot: bad input.type ${String(o.input?.type)}`)
  if (typeof o.input.source !== 'string') throw new Error('invalid snapshot: missing input.source')
  if (!Array.isArray(o.viewports)) throw new Error('invalid snapshot: missing viewports')
  if (!o.screenshots || typeof o.screenshots !== 'object')
    throw new Error('invalid snapshot: missing screenshots')
}

/** Write snapshot.json into dir (dir is created). Sub-asset files are written by callers. */
export async function writeSnapshot(dir: string, s: Snapshot): Promise<void> {
  assertValidSnapshot(s)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'snapshot.json'), JSON.stringify(s, null, 2))
}

/** Read and validate snapshot.json from dir. Throws on missing/invalid. */
export async function readSnapshot(dir: string): Promise<Snapshot> {
  const raw = await readFile(path.join(dir, 'snapshot.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  assertValidSnapshot(parsed)
  return parsed
}
