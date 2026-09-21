import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { serveStatic } from '@copypage/core'

describe('serveStatic', () => {
  const dirPromise = mkdtemp(path.join(tmpdir(), 'cp-serve-'))

  afterAll(async () => {
    await rm(await dirPromise, { recursive: true, force: true })
  })

  it('serves files with correct content and content-type', async () => {
    const dir = await dirPromise
    await writeFile(path.join(dir, 'index.html'), '<h1>hi</h1>')
    const { url, close } = await serveStatic(dir)
    try {
      const res = await fetch(url + '/index.html')
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toBe('<h1>hi</h1>')
    } finally {
      await close()
    }
  })
})
