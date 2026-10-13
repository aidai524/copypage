import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { CaptureJobSpec, VerifyJobSpec } from '../src/jobs.js'
import { buildDockerArgs, mapSpecPaths } from '../src/sandbox.js'

const exec = promisify(execFile)

const DATA_DIR = '/srv/copypage-data'
const REPO_ROOT = '/opt/copypage'

const captureSpec: CaptureJobSpec = {
  kind: 'capture',
  taskId: '20260101-000000-abc',
  snapshotDir: `${DATA_DIR}/tasks/20260101-000000-abc/orig`,
  input: { type: 'url', source: 'https://example.com' },
  options: { viewports: [1440] },
}

const verifySpec: VerifyJobSpec = {
  kind: 'verify',
  taskId: '20260101-000000-abc',
  verificationId: 'v1',
  origDir: `${DATA_DIR}/tasks/20260101-000000-abc/orig`,
  reproDir: `${DATA_DIR}/tasks/20260101-000000-abc/verifications/v1/repro`,
  snapshotDir: `${DATA_DIR}/tasks/20260101-000000-abc/verifications/v1/repro-snap`,
  verificationDir: `${DATA_DIR}/tasks/20260101-000000-abc/verifications/v1`,
  round: 1,
  viewports: [1440],
  allowBuild: false,
  loop: { round: 0, history: [], escalated: false },
}

describe('mapSpecPaths', () => {
  it('rewrites dataDir and repoRoot prefixes to container mounts', () => {
    const mapped = mapSpecPaths(captureSpec, { dataDir: DATA_DIR, repoRoot: REPO_ROOT }) as CaptureJobSpec
    expect(mapped.snapshotDir).toBe('/data/tasks/20260101-000000-abc/orig')
    expect(mapped.input.source).toBe('https://example.com')
  })

  it('rewrites every nested path in a verify spec', () => {
    const mapped = mapSpecPaths(verifySpec, { dataDir: DATA_DIR, repoRoot: REPO_ROOT }) as VerifyJobSpec
    expect(mapped.origDir).toBe('/data/tasks/20260101-000000-abc/orig')
    expect(mapped.reproDir).toBe('/data/tasks/20260101-000000-abc/verifications/v1/repro')
    expect(mapped.verificationDir).toBe('/data/tasks/20260101-000000-abc/verifications/v1')
  })

  it('leaves specs without host paths untouched', () => {
    const spec = { ...captureSpec, snapshotDir: '/data/already/container' }
    expect(mapSpecPaths(spec, { dataDir: DATA_DIR, repoRoot: REPO_ROOT })).toEqual(spec)
  })
})

describe('buildDockerArgs', () => {
  const args = buildDockerArgs(mapSpecPaths(captureSpec, { dataDir: DATA_DIR, repoRoot: REPO_ROOT }), {
    dataDir: DATA_DIR,
    repoRoot: REPO_ROOT,
    image: 'copypage-server:local',
    network: 'copypage-workers',
    memoryMb: 3072,
    cpus: 1,
    pidsLimit: 256,
  })

  it('isolates mounts, resources and network', () => {
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '-i'])
    expect(args).toContain('--memory')
    expect(args[args.indexOf('--memory') + 1]).toBe('3072m')
    expect(args[args.indexOf('--cpus') + 1]).toBe('1')
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('256')
    expect(args[args.indexOf('--network') + 1]).toBe('copypage-workers')
    // repo read-only, data writable
    expect(args).toContain(`${REPO_ROOT}:/app:ro`)
    expect(args).toContain(`${DATA_DIR}:/data`)
    // tmpfs for the browser profile
    expect(args[args.indexOf('--tmpfs') + 1]).toContain('/tmp')
  })

  it('runs the same worker entrypoint inside the container', () => {
    expect(args).toContain('copypage-server:local')
    const imageIndex = args.indexOf('copypage-server:local')
    expect(args.slice(imageIndex + 1)).toEqual([
      'node_modules/.bin/tsx',
      'packages/server/src/worker.ts',
    ])
    // chromium needs --no-sandbox in containers
    expect(args).toContain('COPYPAGE_CHROMIUM_ARGS=--no-sandbox')
  })

  it('passes extra env through', () => {
    const withEnv = buildDockerArgs(captureSpec, {
      dataDir: DATA_DIR,
      repoRoot: REPO_ROOT,
      image: 'img',
      network: 'bridge',
      memoryMb: 1024,
      cpus: 1,
      pidsLimit: 128,
      env: { COPYPAGE_AGENT_MODEL: 'sonnet:high' },
    })
    expect(withEnv).toContain('COPYPAGE_AGENT_MODEL=sonnet:high')
  })
})

describe('docker availability (informational)', () => {
  it('reports whether the daemon is reachable in this environment', async () => {
    try {
      const { stdout } = await exec('docker', ['version', '--format', '{{.Server.Version}}'], {
        timeout: 5000,
      })
      console.log(`docker available: ${stdout.trim()} (sandbox=docker runnable)`)
    } catch (err) {
      console.log(`docker not available here: ${err instanceof Error ? err.message.split('\n')[0] : err}`)
    }
    expect(true).toBe(true)
  })
})
