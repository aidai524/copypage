import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveStatic, type StaticServer } from '@copypage/core'
import { captureSite } from '@copypage/capture'
import { captureRepro } from '@copypage/render'
import { decide, diffSnapshots, type LoopState } from '@copypage/diff'
import { buildFixPrompt, buildGeneratePrompt, runAgentTurn, runGenerationLoop } from '../src/index.js'

const FIXTURE = path.resolve(__dirname, '../../../fixtures/site')
const BROKEN = path.resolve(__dirname, '../../../fixtures/site-broken')
const STUB = path.resolve(__dirname, '../../../fixtures/agent-stub/stub-agent.mjs')
const REPO_ROOT = path.resolve(__dirname, '../../..')

describe('prompt builders', () => {
  it('generate prompt carries paths, viewports and hard rules', () => {
    const prompt = buildGeneratePrompt({
      origDir: '/tmp/orig',
      reproDir: '/tmp/repro',
      viewports: [1440, 375],
      taskDir: '/tmp',
    })
    expect(prompt).toContain('/tmp/orig')
    expect(prompt).toContain('/tmp/repro')
    expect(prompt).toContain('1440 / 375')
    expect(prompt).toContain('不要运行 diff')
  })

  it('fix prompt lists entries with expected/actual', () => {
    const prompt = buildFixPrompt({
      round: 3,
      reproDir: '/tmp/repro',
      entries: [
        { severity: 8.2, element: 'button.cta', property: 'boxShadow', expected: '0 4px', actual: 'none' },
      ],
      metrics: { ssim: 0.91, pixelDiffPct: 3.2, dynamicAreaPct: 8 },
    })
    expect(prompt).toContain('第 3 轮修复')
    expect(prompt).toContain('button.cta')
    expect(prompt).toContain('SSIM 0.91')
    expect(prompt).toContain('动态区域 8%')
  })
})

describe('runAgentTurn', () => {
  it('parses JSONL progress and returns accumulated text', async () => {
    const progress: string[] = []
    const result = await runAgentTurn('hello', {
      repoRoot: REPO_ROOT,
      sessionId: 'stub-test',
      command: 'node',
      commandArgs: [STUB],
      onProgress: (m) => progress.push(m),
    })
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('done')
    expect(progress.some((m) => m.includes('bash:'))).toBe(true)
    expect(progress.some((m) => m.includes('session'))).toBe(true)
  })

  it('surfaces agent failures with stderr context', async () => {
    const failing = path.join(await mkdtemp(path.join(tmpdir(), 'cp-agent-')), 'fail.mjs')
    await writeFile(failing, 'process.stderr.write("boom"); process.exit(2)')
    await expect(
      runAgentTurn('hello', {
        repoRoot: REPO_ROOT,
        sessionId: 'stub-fail',
        command: 'node',
        commandArgs: [failing],
        onProgress: () => {},
      }),
    ).rejects.toThrow('agent exited with 2')
    await rm(path.dirname(failing), { recursive: true, force: true })
  })
})

describe('runGenerationLoop', () => {
  let server: StaticServer
  let workDir: string

  beforeAll(async () => {
    server = await serveStatic(FIXTURE)
    workDir = await mkdtemp(path.join(tmpdir(), 'cp-gen-'))
    await captureSite(server.url, path.join(workDir, 'orig'), {
      viewports: [800],
      dynamic: false,
      states: false,
    })
  }, 120_000)

  afterAll(async () => {
    await server.close()
    await rm(workDir, { recursive: true, force: true })
  })

  it('drives agent rounds until verification passes', async () => {
    const origDir = path.join(workDir, 'orig')
    const reproDir = path.join(workDir, 'repro')
    const snapDir = path.join(workDir, 'repro-snap')
    const progress: string[] = []
    let loop: LoopState = { round: 0, history: [], escalated: false }

    const result = await runGenerationLoop({
      repoRoot: REPO_ROOT,
      origDir,
      reproDir,
      viewports: [800],
      sessionId: 'gen-loop-test',
      command: 'node',
      commandArgs: [STUB],
      extraEnv: { STUB_ROUND1_SRC: BROKEN, STUB_ROUND2_SRC: FIXTURE },
      maxRounds: 4,
      onProgress: (m) => progress.push(m),
      verify: async (round) => {
        await captureRepro(reproDir, snapDir, { viewports: [800] })
        const diff = await diffSnapshots(origDir, snapDir, path.join(workDir, `diffs/r${round}`), { round })
        const decision = decide(loop, diff.metrics)
        loop = {
          round,
          history: [...loop.history, diff.metrics],
          escalated: loop.escalated || decision === 'escalate',
        }
        return {
          metrics: diff.metrics,
          decision,
          topEntries: diff.entries.slice(0, 10).map((e) => ({
            severity: e.severity,
            element: e.element,
            property: e.property,
            expected: String(e.expected),
            actual: String(e.actual),
          })),
        }
      },
    })

    expect(result.rounds.length).toBe(2)
    expect(result.rounds[0].decision).toBe('continue')
    expect(result.rounds[0].metrics.pixelDiffPct).toBeGreaterThan(2)
    expect(result.rounds[1].decision).toBe('pass')
    expect(result.rounds[1].metrics.ssim).toBeGreaterThan(0.99)
    expect(result.finalDecision).toBe('pass')
    expect(progress.some((m) => m.includes('round 2/4: agent working'))).toBe(true)
    expect(progress.some((m) => m.includes('→ pass'))).toBe(true)
  }, 180_000)
})
