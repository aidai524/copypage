import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertSafeZip, extractReproZip } from '../src/repro.js'

const exec = promisify(execFile)

describe('repro zip handling', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-repro-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('extracts a zip and unwraps a single top-level folder', async () => {
    const parent = path.join(dir, 'parent')
    await mkdir(path.join(parent, 'my-repro'), { recursive: true })
    await writeFile(path.join(parent, 'my-repro', 'index.html'), '<html></html>')
    const zip = path.join(dir, 'repro.zip')
    await exec('bsdtar', ['-a', '-cf', zip, '-C', parent, 'my-repro'])

    const reproDir = await extractReproZip(zip, path.join(dir, 'out'))
    expect(reproDir).toBe(path.join(dir, 'out', 'my-repro'))
  })

  it('rejects zip entries that escape the extraction root', async () => {
    const file = path.join(dir, 'secret.txt')
    await writeFile(file, 'top secret')
    const zip = path.join(dir, 'abs.zip')
    await exec('bsdtar', ['-cf', zip, '-P', file])

    await expect(assertSafeZip(zip)).rejects.toThrow('unsafe zip entry')
    await expect(extractReproZip(zip, path.join(dir, 'out'))).rejects.toThrow('unsafe zip entry')
  })
})
