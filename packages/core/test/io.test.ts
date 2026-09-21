import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readSnapshot, writeSnapshot, type Snapshot } from '@copypage/core'

const sample: Snapshot = {
  input: { type: 'url', source: 'http://localhost:1234/' },
  viewports: [800],
  screenshots: { '800': 'screenshots/800.png' },
  dom: [],
}

describe('snapshot io', () => {
  it('roundtrips a snapshot through writeSnapshot/readSnapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cp-io-'))
    try {
      await writeSnapshot(dir, sample)
      const back = await readSnapshot(dir)
      expect(back).toEqual(sample)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('throws when snapshot.json is missing required fields', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cp-io-'))
    try {
      await writeSnapshot(dir, sample)
      // corrupt: rewrite with missing input.type
      const { writeFile } = await import('node:fs/promises')
      await writeFile(path.join(dir, 'snapshot.json'), JSON.stringify({ input: { source: 'x' } }))
      await expect(readSnapshot(dir)).rejects.toThrow(/invalid snapshot/i)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
