#!/usr/bin/env tsx
import { startServer } from './index.js'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const port = Number(arg('port', '4400'))
const host = arg('host', '127.0.0.1')!
const dataDir = arg('data-dir', 'work/server')!
const token = arg('token')
const maxTasks = Number(arg('max-tasks', '50'))
const maxUploadMb = Number(arg('max-upload-mb', '200'))
const retentionHours = Number(arg('retention-hours', '168'))
const allowPrivateNetwork = flag('allow-private-network')
const allowBuild = flag('allow-build')
const allowAgent = flag('allow-agent')
const agentModel = arg('agent-model')
const agentCommand = arg('agent-command', 'pi')!
const agentMaxRounds = Number(arg('agent-max-rounds', '8'))
const agentTimeoutMin = Number(arg('agent-timeout-min', '30'))
const rateLimitPerMinute = Number(arg('rate-limit-per-minute', '120'))
const trustProxy = flag('trust-proxy')

const server = await startServer({
  port,
  host,
  dataDir,
  maxTasks,
  maxUploadBytes: maxUploadMb * 1024 * 1024,
  retentionMs: retentionHours * 3600_000,
  allowPrivateNetwork,
  allowBuild,
  allowAgent,
  agentCommand,
  agentMaxRounds,
  agentTimeoutMs: agentTimeoutMin * 60_000,
  rateLimitPerMinute,
  trustProxy,
  ...(token ? { token } : {}),
  ...(agentModel ? { agentModel } : {}),
})

console.log(`CopyPage capture service → ${server.url}`)
console.log(`  data dir: ${dataDir}`)
console.log(`  auth: ${token ? 'bearer token required' : 'OPEN (loopback only)'}`)
console.log(`  retention: ${retentionHours}h · max tasks: ${maxTasks} · max upload: ${maxUploadMb}MB`)
if (allowBuild) console.log('  ⚠ --allow-build: submitted projects run `npm run build` (arbitrary code execution)')
if (allowPrivateNetwork) console.log('  ⚠ --allow-private-network: SSRF guard disabled (local fixtures only)')
if (allowAgent)
  console.log(
    `  ⚠ --allow-agent: agent "${agentCommand}" runs with shell access to generate repros` +
      (agentModel ? ` (model ${agentModel})` : '') +
      `, up to ${agentMaxRounds} rounds × ${agentTimeoutMin}min`,
  )
console.log('  POST /api/tasks   { type: "url", source: "https://…", options? }')
console.log('  POST /api/tasks/:id/verifications   { repro: { type: "path", source } }  |  raw zip')
console.log('  POST /api/tasks/:id/generate        agent-driven repro generation (with --allow-agent)')
console.log('  GET  /api/tasks   list   |  /api/events SSE  |  /  UI')

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// keep the process alive while the server runs
await new Promise(() => {})
