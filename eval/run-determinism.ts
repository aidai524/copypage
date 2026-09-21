#!/usr/bin/env tsx
/**
 * Determinism harness: capture the same URL twice and diff.
 * Healthy instrumentation means ssim ≈ 1. Usage:
 *   npx tsx eval/run-determinism.ts <url>
 * Or evaluate the public eval set:  npx tsx eval/run-determinism.ts --set
 */
import { mkdtemp } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { captureSite } from '@copypage/capture'
import { diffSnapshots } from '@copypage/diff'

async function check(url: string): Promise<{ url: string; ssim: number; pixelDiffPct: number }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cp-eval-'))
  await captureSite(url, path.join(dir, 'a'))
  await captureSite(url, path.join(dir, 'b'))
  const r = await diffSnapshots(path.join(dir, 'a'), path.join(dir, 'b'), path.join(dir, 'out'))
  return { url, ...r.metrics }
}

const target = process.argv[2]
if (!target) {
  console.error('usage: run-determinism.ts <url> | --set')
  process.exit(1)
}

const urls =
  target === '--set'
    ? (await readFile(new URL('./urls.txt', import.meta.url), 'utf8'))
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    : [target]

for (const url of urls) {
  try {
    const r = await check(url)
    const verdict = r.ssim >= 0.999 ? 'PASS' : 'FAIL'
    console.log(`${verdict} ${r.url} ssim=${r.ssim} pixelDiffPct=${r.pixelDiffPct}`)
  } catch (err) {
    console.log(`ERROR ${url} ${String(err).slice(0, 200)}`)
  }
}
