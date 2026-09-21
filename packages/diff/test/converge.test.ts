import { describe, expect, it } from 'vitest'
import { decide, type LoopState } from '../src/converge.js'

function state(round: number, diffs: number[], escalated = false): LoopState {
  return { round, history: diffs.map((d) => ({ ssim: 0.9, pixelDiffPct: d })), escalated }
}

describe('decide', () => {
  it('pass when thresholds met', () => {
    expect(decide(state(2, [5, 1.8]), { ssim: 0.985, pixelDiffPct: 1.8 })).toBe('pass')
  })

  it('continue while improving', () => {
    expect(decide(state(2, [8, 5]), { ssim: 0.95, pixelDiffPct: 3 })).toBe('continue')
  })

  it('escalate on first stagnation (2 rounds < 0.5 improvement)', () => {
    expect(decide(state(3, [5, 4.8, 4.6]), { ssim: 0.95, pixelDiffPct: 4.5 })).toBe('escalate')
  })

  it('stagnant-stop when stagnation persists after escalation', () => {
    expect(decide(state(5, [5, 4.8, 4.7, 4.65], true), { ssim: 0.95, pixelDiffPct: 4.6 })).toBe('stagnant-stop')
  })

  it('cap-stop at round 8 regardless', () => {
    expect(decide(state(8, [9, 8, 7]), { ssim: 0.9, pixelDiffPct: 6 })).toBe('cap-stop')
  })
})
