import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveStatic, type StaticServer } from '@copypage/core'
import { captureSite } from '@copypage/capture'
import { diffSnapshots } from '../src/index.js'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')

describe('capture determinism', () => {
  let dir: string
  let server: StaticServer

  afterAll(async () => {
    if (server) await server.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('capturing the same page twice yields ssim >= 0.999', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-det-'))
    server = await serveStatic(FIXTURE)
    await captureSite(server.url, path.join(dir, 'a'), { viewports: [800] })
    await captureSite(server.url, path.join(dir, 'b'), { viewports: [800] })
    const result = await diffSnapshots(path.join(dir, 'a'), path.join(dir, 'b'), path.join(dir, 'out'))
    expect(result.metrics.ssim).toBeGreaterThanOrEqual(0.999)
    expect(result.metrics.pixelDiffPct).toBeLessThan(0.1)
  }, 180000)
})
