import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveStatic, readSnapshot, type StaticServer } from '@copypage/core'
import { captureSite } from '../src/site.js'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')

describe('captureSite', () => {
  let server: StaticServer
  let outDir: string

  beforeAll(async () => {
    server = await serveStatic(FIXTURE)
    outDir = await mkdtemp(path.join(tmpdir(), 'cp-site-'))
    await captureSite(server.url, outDir, { viewports: [800] })
  }, 120000)

  afterAll(async () => {
    await server.close()
    await rm(outDir, { recursive: true, force: true })
  })

  it('writes screenshot, dom snapshot and meta for each viewport', async () => {
    await access(path.join(outDir, 'screenshots', '800.png'))
    await access(path.join(outDir, 'dom', '800.json'))
    await access(path.join(outDir, 'meta.json'))
  })

  it('captures meta fields', async () => {
    const meta = JSON.parse(await readFile(path.join(outDir, 'meta.json'), 'utf8'))
    expect(meta.title).toBe('CopyPage Fixture Site')
    expect(meta.colorScheme).toBe('light')
    expect(typeof meta.backgroundColor).toBe('string')
  })

  it('dom snapshot root is body with path ids', async () => {
    const dom = JSON.parse(await readFile(path.join(outDir, 'dom', '800.json'), 'utf8'))
    expect(dom.root.tag).toBe('body')
    expect(dom.viewport.width).toBe(800)
    expect(dom.url).toBe(server.url + '/')
  })

  it('writes a valid snapshot.json readable by readSnapshot', async () => {
    const snap = await readSnapshot(outDir)
    expect(snap.input.type).toBe('url')
    expect(snap.screenshots['800']).toBe('screenshots/800.png')
    expect(snap.dom).toHaveLength(1)
  })
})
