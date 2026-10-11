import { execFile } from 'node:child_process'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export class ReproError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReproError'
  }
}

/** Zip entries must stay inside the extraction root (zip-slip guard). */
export async function assertSafeZip(zipPath: string): Promise<void> {
  let stdout: string
  try {
    ;({ stdout } = await exec('bsdtar', ['-tf', zipPath], { maxBuffer: 16 * 1024 * 1024 }))
  } catch (err) {
    throw new ReproError(`cannot read zip: ${err instanceof Error ? err.message : String(err)}`)
  }
  const entries = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (entries.length === 0) throw new ReproError('zip archive is empty')
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.startsWith('\\') || entry.split('/').includes('..')) {
      throw new ReproError(`unsafe zip entry: ${entry}`)
    }
  }
}

/**
 * Extract an uploaded repro zip and return the directory that contains the
 * project root. Archives that wrap everything in one top-level folder are
 * unwrapped so `package.json`/`index.html` are found where expected.
 */
export async function extractReproZip(zipPath: string, destDir: string): Promise<string> {
  await assertSafeZip(zipPath)
  await rm(destDir, { recursive: true, force: true })
  await mkdir(destDir, { recursive: true })
  await exec('bsdtar', ['-xf', zipPath, '-C', destDir], { maxBuffer: 16 * 1024 * 1024 })

  const entries = await readdir(destDir, { withFileTypes: true })
  const visible = entries.filter((e) => e.name !== '__MACOSX' && !e.name.startsWith('.'))
  if (visible.length === 1 && visible[0].isDirectory()) {
    return path.join(destDir, visible[0].name)
  }
  return destDir
}
