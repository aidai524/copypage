#!/usr/bin/env tsx
/**
 * Isolated job worker. The supervisor spawns one process per job, streams a
 * job spec on stdin and reads JSONL WorkerEvents from stdout. Nothing here
 * touches the database — the supervisor owns all task state.
 */
import { runCaptureJob, runGenerateJob, runVerifyJob, type JobSpec } from './jobs.js'
import type { WorkerEvent } from './types.js'

const chunks: Buffer[] = []
for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
const spec = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JobSpec

const emit = (event: WorkerEvent): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

// keep unhandled async noise from killing the worker before it reports
process.on('unhandledRejection', (reason) => {
  emit({ type: 'error', error: `unhandled rejection: ${String(reason)}` })
  process.exitCode = 1
})

try {
  if (spec.kind === 'capture') await runCaptureJob(spec, emit)
  else if (spec.kind === 'verify') await runVerifyJob(spec, emit)
  else await runGenerateJob(spec, emit)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  const output = (err as { output?: unknown }).output
  emit({
    type: 'error',
    error: output ? `${message}\n${String(output).slice(-4000)}` : message,
  })
  process.exitCode = 1
}
