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

export interface CaptureReproOptions extends CaptureSiteOptions {
  /**
   * Run `npm run build` when the repro has a package.json but no dist yet.
   * Executing a submitted project's build script is arbitrary code execution,
   * so server deployments disable it and require a prebuilt dist/.
   */
  allowBuild?: boolean
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
  opts: CaptureReproOptions = {},
): Promise<void> {
  const hasPkg = await exists(path.join(reproDir, 'package.json'))
  const distDir = path.join(reproDir, 'dist')
  const hasDistIndex = await exists(path.join(distDir, 'index.html'))

  // Vite-style projects have a root index.html — never let it fool us into
  // skipping the build. Build whenever there's a build script and no dist.
  if (hasPkg && !hasDistIndex) {
    if (opts.allowBuild === false) {
      throw new BuildError(
        `server-side build is disabled: ${reproDir} has package.json but no dist/index.html`,
        'Upload a prebuilt dist/ (or a static bundle), or run the server with --allow-build.',
      )
    }
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
    const { allowBuild: _allowBuild, ...captureOpts } = opts
    // states capture is expensive — skip when probing the repro mid-loop.
    // dynamic-region sampling is for live originals: the repro is static by design.
    await captureSite(server.url, outDir, { states: false, dynamic: false, ...captureOpts })
  } finally {
    await server.close()
  }
}
