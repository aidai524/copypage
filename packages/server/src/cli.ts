#!/usr/bin/env tsx
import { startServer } from './index.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
/**
 * Tri-state flag: `--x` is true, `--no-x` is false, absent is undefined.
 * Absent must stay undefined, otherwise the default below (.env value) never
 * gets a chance: `partial.x ?? envBool(...)` would keep the CLI's false.
 */
function flag(name: string): boolean | undefined {
  if (process.argv.includes(`--${name}`)) return true
  if (process.argv.includes(`--no-${name}`)) return false
  return undefined
}
/** only send values that were actually asked for on the command line */
const given = <T>(key: string, value: T | undefined): Record<string, T> =>
  value === undefined ? {} : { [key]: value }
const givenBool = (key: string, value: boolean | undefined): Record<string, boolean> =>
  value === undefined ? {} : { [key]: value }

const num = (name: string): number | undefined => {
  const raw = arg(name)
  return raw === undefined ? undefined : Number(raw)
}
const port = num('port')
const host = arg('host')
const dataDir = arg('data-dir')
const token = arg('token')
const maxTasks = num('max-tasks')
const maxUploadMb = num('max-upload-mb')
const retentionHours = num('retention-hours')
const allowPrivateNetwork = flag('allow-private-network')
const allowBuild = flag('allow-build')
const allowAgent = flag('allow-agent')
const agentModel = arg('agent-model')
const agentCommand = arg('agent-command')
const agentMaxRounds = num('agent-max-rounds')
const agentTimeoutMin = num('agent-timeout-min')
const rateLimitPerMinute = num('rate-limit-per-minute')
const trustProxy = flag('trust-proxy')
const allowRegistration = flag('allow-registration')
const adminEmail = arg('admin-email')
const adminPassword = arg('admin-password')
const workerConcurrency = num('worker-concurrency')
const workerMemoryMb = num('worker-memory-mb')
const sandboxArg = arg('sandbox')
const sandbox = sandboxArg === undefined ? undefined : sandboxArg === 'docker' ? 'docker' : 'process'
const workerImage = arg('worker-image')
const workerNetwork = arg('worker-network')
const workerCpus = num('worker-cpus')
const databaseUrl = arg('database-url')

const server = await startServer({
  ...givenBool('allowPrivateNetwork', allowPrivateNetwork),
  ...givenBool('allowBuild', allowBuild),
  ...givenBool('allowAgent', allowAgent),
  ...givenBool('trustProxy', trustProxy),
  ...givenBool('allowRegistration', allowRegistration),
  ...given('port', port),
  ...given('host', host),
  ...given('dataDir', dataDir),
  ...given('maxTasks', maxTasks),
  ...given('maxUploadBytes', maxUploadMb === undefined ? undefined : maxUploadMb * 1024 * 1024),
  ...given('retentionMs', retentionHours === undefined ? undefined : retentionHours * 3600_000),
  ...given('agentCommand', agentCommand),
  ...given('agentMaxRounds', agentMaxRounds),
  ...given('agentTimeoutMs', agentTimeoutMin === undefined ? undefined : agentTimeoutMin * 60_000),
  ...given('rateLimitPerMinute', rateLimitPerMinute),
  ...given('workerConcurrency', workerConcurrency),
  ...given('workerMemoryMb', workerMemoryMb),
  ...given('sandbox', sandbox),
  ...given('workerImage', workerImage),
  ...given('workerNetwork', workerNetwork),
  ...given('workerCpus', workerCpus),
  ...given('databaseUrl', databaseUrl),
  ...given('adminEmail', adminEmail),
  ...given('adminPassword', adminPassword),
  ...given('token', token),
  ...given('agentModel', agentModel),
})

// everything below is the *effective* config (flag > env > default), so the banner
// can be trusted when an operator checks whether a .env switch took effect
const cfg = server.config
console.log(`Kloon capture service → ${server.url}`)
console.log(`  data dir: ${cfg.dataDir}`)
console.log(`  auth: ${cfg.token ? 'bearer token required' : 'OPEN (loopback only)'}`)
console.log(`  retention: ${Math.round(cfg.retentionMs / 3600_000)}h · max tasks: ${cfg.maxTasks} · max upload: ${Math.round(cfg.maxUploadBytes / 1024 / 1024)}MB`)
console.log(
  `  workers: ${cfg.workerConcurrency} × ${cfg.workerMemoryMb}MB (${cfg.sandbox}) · registration: ${cfg.allowRegistration ? 'open' : 'closed'}` +
    (cfg.adminEmail ? ` · admin: ${cfg.adminEmail}` : ''),
)
if (cfg.allowBuild) console.log('  ⚠ allow-build: submitted projects run `npm run build` (arbitrary code execution)')
if (cfg.allowPrivateNetwork) console.log('  ⚠ allow-private-network: SSRF guard disabled (local fixtures only)')
if (cfg.allowAgent)
  console.log(
    `  ⚠ allow-agent: agent "${cfg.agentCommand}" runs with shell access to generate repros` +
      (cfg.agentModel ? ` (model ${cfg.agentModel})` : '') +
      `, up to ${cfg.agentMaxRounds} rounds × ${Math.round(cfg.agentTimeoutMs / 60_000)}min`,
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
