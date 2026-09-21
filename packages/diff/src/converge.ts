export interface Metrics {
  ssim: number
  pixelDiffPct: number
}

export interface LoopState {
  round: number
  history: Metrics[]
  escalated: boolean
}

export type Decision = 'pass' | 'continue' | 'escalate' | 'stagnant-stop' | 'cap-stop'

export const THRESHOLDS = {
  ssim: 0.98,
  pixelDiffPct: 2,
  stagnationDelta: 0.5,
  stagnationRounds: 2,
  maxRounds: 8,
} as const

/**
 * Convergence policy (spec §6):
 * pass > cap > stagnation (escalate once, then stop) > continue.
 */
export function decide(state: LoopState, m: Metrics): Decision {
  if (m.ssim >= THRESHOLDS.ssim && m.pixelDiffPct <= THRESHOLDS.pixelDiffPct) return 'pass'
  if (state.round >= THRESHOLDS.maxRounds) return 'cap-stop'

  const recent = state.history.slice(-THRESHOLDS.stagnationRounds)
  if (recent.length === THRESHOLDS.stagnationRounds) {
    // improvement between consecutive rounds incl. current
    const chain = [...recent.map((h) => h.pixelDiffPct), m.pixelDiffPct]
    const deltas = chain.slice(1).map((v, i) => chain[i] - v)
    if (deltas.every((d) => d < THRESHOLDS.stagnationDelta)) {
      return state.escalated ? 'stagnant-stop' : 'escalate'
    }
  }
  return 'continue'
}
