#!/usr/bin/env node
/**
 * Minimal `pi --mode json` compatible stub for generator tests: emits JSONL
 * events and copies a fixture into COPYPAGE_REPRO_DIR (round1/round2 sources).
 */
import { cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const round = Number(process.env.COPYPAGE_ROUND || '1')
const reproDir = process.env.COPYPAGE_REPRO_DIR
const here = path.dirname(fileURLToPath(import.meta.url))
// default to sibling fixtures so hosts do not need to inject env vars
const src =
  (round === 1 ? process.env.STUB_ROUND1_SRC : process.env.STUB_ROUND2_SRC) ??
  path.join(here, round === 1 ? '../site-broken' : '../site')

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)

emit({ type: 'session', version: 3, id: 'stub-session', timestamp: new Date().toISOString(), cwd: process.cwd() })
emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: `round ${round}: generating…` } })
emit({
  type: 'tool_execution_start',
  toolCallId: 't1',
  toolName: 'bash',
  args: { command: 'echo generating' },
})

if (src && reproDir) {
  await rm(reproDir, { recursive: true, force: true })
  await mkdir(path.dirname(reproDir), { recursive: true })
  await cp(src, reproDir, { recursive: true })
}

emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: {}, isError: false })
emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' done' } })
emit({ type: 'agent_settled', aborted: false })
