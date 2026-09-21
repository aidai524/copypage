#!/usr/bin/env tsx
import { diffSnapshots } from './index.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const orig = arg('orig')
const repro = arg('repro')
const out = arg('out')
const round = Number(arg('round') ?? '1')

if (!orig || !repro || !out) {
  console.error('usage: npm run diff -- --orig <snapshotDir> --repro <snapshotDir> --out <diffDir> [--round N]')
  process.exit(1)
}

const result = await diffSnapshots(orig, repro, out, { round })
console.log(JSON.stringify(result.metrics))
console.log(`${result.entries.length} diff entries → ${out}/diff.json`)
