import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { JobSpec } from './jobs.js'

const exec = promisify(execFile)

export interface SandboxOptions {
  /** host data directory mounted at /data in the container */
  dataDir: string
  /** host repo root mounted read-only at /app */
  repoRoot: string
  image: string
  network: string
  memoryMb: number
  cpus: number
  pidsLimit: number
  /** env passed to the container */
  env?: Record<string, string>
}

/**
 * Rewrite host paths inside a job spec to container paths. Every path a job
 * touches lives under dataDir (artifacts) or repoRoot (the worker/skill), so a
 * plain prefix swap is sufficient and keeps the worker code unchanged.
 */
export function mapSpecPaths(spec: JobSpec, opts: { dataDir: string; repoRoot: string }): JobSpec {
  const serialized = JSON.stringify(spec)
    .split(JSON.stringify(opts.dataDir).slice(1, -1))
    .join('/data')
    .split(JSON.stringify(opts.repoRoot).slice(1, -1))
    .join('/app')
  return JSON.parse(serialized) as JobSpec
}

/** `docker run` argv for one isolated worker job (stdin carries the spec). */
export function buildDockerArgs(spec: JobSpec, opts: SandboxOptions): string[] {
  return [
    'run',
    '--rm',
    '-i',
    '--memory',
    `${opts.memoryMb}m`,
    '--cpus',
    String(opts.cpus),
    '--pids-limit',
    String(opts.pidsLimit),
    '--network',
    opts.network,
    '--tmpfs',
    '/tmp:rw,size=1g',
    '-v',
    `${opts.repoRoot}:/app:ro`,
    '-v',
    `${opts.dataDir}:/data`,
    '-w',
    '/app',
    '-e',
    'COPYPAGE_CHROMIUM_ARGS=--no-sandbox',
    ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    opts.image,
    'node_modules/.bin/tsx',
    'packages/server/src/worker.ts',
  ]
}

/** Fail fast when the deployment asks for sandboxing but Docker is unusable. */
export async function assertDockerAvailable(): Promise<string> {
  try {
    const { stdout } = await exec('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000 })
    return stdout.trim()
  } catch (err) {
    throw new Error(
      `sandbox=docker requires a working Docker daemon: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
