import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ensureEnvLoaded } from '../src/vlm.js'

describe('ensureEnvLoaded', () => {
  let dir: string
  const KEY = 'CP_TEST_ENV_VAR'

  afterAll(async () => {
    delete process.env[KEY]
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('loads vars from .env in the given dir without clobbering existing', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-env-'))
    await writeFile(path.join(dir, '.env'), `${KEY}=from-file\nAPIMART_API_KEY=should-not-load\n`)
    delete process.env[KEY]
    process.env.APIMART_API_KEY = 'preexisting'

    ensureEnvLoaded(dir)

    expect(process.env[KEY]).toBe('from-file')
    // never clobbers an existing var
    expect(process.env.APIMART_API_KEY).toBe('preexisting')
    delete process.env.APIMART_API_KEY
  })

  it('is a no-op when .env is missing', () => {
    expect(() => ensureEnvLoaded(path.join(tmpdir(), 'cp-env-nonexistent'))).not.toThrow()
  })
})
