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
  const hasPkg = await exists(path.join(reproDir, 'package.json'))
  const distDir = path.join(reproDir, 'dist')
  const hasDistIndex = await exists(path.join(distDir, 'index.html'))

  // Vite-style projects have a root index.html — never let it fool us into
  // skipping the build. Build whenever there's a build script and no dist.
  if (hasPkg && !hasDistIndex) {
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

  const serveDir = (await exists(path.join(distDir, 'index.html'))) ? distDir : reproDir
  const server = await serveStatic(serveDir)
  try {
    // states capture is expensive — skip when probing the repro mid-loop.
    // dynamic-region sampling is for live originals: the repro is static by design.
    await captureSite(server.url, outDir, { states: false, dynamic: false, ...opts })
  } finally {
    await server.close()
  }
}
