import { describe, expect, it, afterAll } from 'vitest'
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeBriefScaffold, validateBrief } from '../src/brief.js'

describe('visual brief', () => {
  let dir: string

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('writeBriefScaffold writes schema + prompt', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cp-brief-'))
    await writeBriefScaffold(dir, 'image')
    await access(path.join(dir, 'visual-brief.schema.json'))
    const prompt = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(dir, 'brief-prompt.md'), 'utf8'),
    )
    expect(prompt).toContain('visual-brief.json')
  })

  it('validateBrief accepts a valid brief', async () => {
    const valid = {
      regions: [{ name: 'hero', box: { x: 0, y: 0, width: 1440, height: 600 } }],
      components: [{ type: 'button', box: { x: 100, y: 200, width: 160, height: 48 } }],
      palette: ['#6366f1'],
      fonts: ['Inter'],
      charts: [],
    }
    await writeFile(path.join(dir, 'visual-brief.json'), JSON.stringify(valid))
    const brief = await validateBrief(dir)
    expect(brief.regions[0].name).toBe('hero')
  })

  it('validateBrief rejects a brief missing regions', async () => {
    await writeFile(path.join(dir, 'visual-brief.json'), JSON.stringify({ components: [] }))
    await expect(validateBrief(dir)).rejects.toThrow()
  })
})
