#!/usr/bin/env tsx
import { readFile, writeFile } from 'node:fs/promises'
import { decide, type LoopState, type Metrics } from './converge.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const statePath = arg('state')
const diffPath = arg('diff')

if (!statePath || !diffPath) {
  console.error('usage: tsx packages/diff/src/converge-cli.ts --state <state.json> --diff <diff.json>')
  process.exit(1)
}

const state: LoopState = JSON.parse(await readFile(statePath, 'utf8'))
const diff: { metrics: Metrics } = JSON.parse(await readFile(diffPath, 'utf8'))

const decision = decide(state, diff.metrics)
const next: LoopState = {
  round: state.round + 1,
  history: [...state.history, diff.metrics],
  escalated: state.escalated || decision === 'escalate',
}
await writeFile(statePath, JSON.stringify(next, null, 2))
console.log(decision)
