import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { serveStatic } from '@copypage/core'
import { captureSite, type CaptureSiteOptions } from '@copypage/capture'

export class BuildError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message)
    this.name = 'BuildError'
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Capture the reproduction project: build (if it has a build script and no
 * dist yet), serve statically, run the same site capture used for originals.
 */
export async function captureRepro(
  reproDir: string,
  outDir: string,
  opts: CaptureSiteOptions = {},
): Promise<void> {
  const distDir = (await exists(path.join(reproDir, 'dist')))
    ? path.join(reproDir, 'dist')
    : reproDir

  if (!(await exists(path.join(distDir, 'index.html'))) && (await exists(path.join(reproDir, 'package.json')))) {
    // needs a build
    await new Promise<void>((resolve, reject) => {
      execFile(
        'npm',
        ['run', 'build'],
        { cwd: reproDir, timeout: 300000 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new BuildError(`repro build failed in ${reproDir}`, `${stdout}\n${stderr}`))
          } else {
            resolve()
          }
        },
      )
    })
  }

  const serveDir = (await exists(path.join(reproDir, 'dist'))) ? path.join(reproDir, 'dist') : distDir
  const server = await serveStatic(serveDir)
  try {
    await captureSite(server.url, outDir, opts)
  } finally {
    await server.close()
  }
}
