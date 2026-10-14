import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI = path.resolve(__dirname, '../src/cli.ts')
const TSX = path.resolve(__dirname, '../../../node_modules/.bin/tsx')

/**
 * Boot the real CLI and read its startup banner, which prints the *effective*
 * config. This guards a bug that bit us in production: the CLI computed every
 * switch with a default (`flag()` → false, `arg(name, '50')` → 50) and passed it
 * down, so `partial.x ?? envBool(...)` kept the CLI value and the documented
 * `.env` knobs (registration, trust proxy, worker concurrency, …) were ignored.
 */
async function bannerFromCli(env: Record<string, string>, args: string[] = []): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cp-cli-'))
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(TSX, [CLI, '--data-dir', dataDir, '--port', '0', ...args], {
        env: { ...process.env, COPYPAGE_TOKEN: 'cli-env-test-token', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`CLI did not print a banner in time. Output so far:\n${out}`))
      }, 60_000)
      const done = (fn: () => void) => {
        clearTimeout(timer)
        child.kill('SIGKILL')
        fn()
      }
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('POST /api/tasks')) done(() => resolve(out))
      })
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()))
      child.on('error', (err) => done(() => reject(err)))
      child.on('exit', (code) => {
        if (!out.includes('POST /api/tasks')) done(() => reject(new Error(`CLI exited with ${code}:\n${out}`)))
      })
    })
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
}

describe('cli configuration', () => {
  it('lets .env values through instead of shadowing them with CLI defaults', async () => {
    const banner = await bannerFromCli({
      COPYPAGE_ALLOW_REGISTRATION: 'true',
      COPYPAGE_TRUST_PROXY: 'true',
      COPYPAGE_WORKER_CONCURRENCY: '1',
      COPYPAGE_WORKER_MEMORY_MB: '1536',
      COPYPAGE_MAX_TASKS: '7',
      COPYPAGE_RETENTION_HOURS: '24',
    })
    expect(banner).toContain('registration: open')
    expect(banner).toContain('workers: 1 × 1536MB')
    expect(banner).toContain('retention: 24h · max tasks: 7')
  }, 90_000)

  it('still lets an explicit flag win over .env, and --no-x turn it off', async () => {
    const on = await bannerFromCli({ COPYPAGE_ALLOW_REGISTRATION: 'false' }, ['--allow-registration'])
    expect(on).toContain('registration: open')

    const off = await bannerFromCli({ COPYPAGE_ALLOW_REGISTRATION: 'true' }, ['--no-allow-registration'])
    expect(off).toContain('registration: closed')
  }, 120_000)
})
