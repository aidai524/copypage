export interface ServerConfig {
  host: string
  port: number
  dataDir: string
  publicDir?: string
  /** when set, every /api/* request must present this bearer token */
  token?: string
  /** allow captures/verifications that touch loopback/private networks (local fixtures only) */
  allowPrivateNetwork: boolean
  /** run `npm run build` inside submitted repro dirs. OFF by default: build = arbitrary code execution */
  allowBuild: boolean
  /** allow agent-driven generation runs (`pi` with shell access). OFF by default */
  allowAgent: boolean
  /** agent executable for generation */
  agentCommand: string
  /** extra args before the generated agent args (tests/stubs) */
  agentArgs: string[]
  /** model passed to the agent, e.g. "sonnet:high" */
  agentModel?: string
  /** generation loop round cap */
  agentMaxRounds: number
  /** wall-clock limit per agent turn */
  agentTimeoutMs: number
  /** per-IP requests per minute on /api/* (0 disables) */
  rateLimitPerMinute: number
  /** trust X-Forwarded-For (only when every request goes through a proxy) */
  trustProxy: boolean
  /** allow visitors to self-register accounts (public mode) */
  allowRegistration: boolean
  /** bootstrap admin credentials (created on first start) */
  adminEmail?: string
  adminPassword?: string
  /** jobs running in parallel across all tenants (each runs in a child process) */
  workerConcurrency: number
  /** V8 heap limit for worker processes */
  workerMemoryMb: number
  /** default quotas by plan (per-user overrides live in the database) */
  plans: Record<string, Quota>
  /** hard cap on stored tasks; new captures are rejected above it */
  maxTasks: number
  /** max upload size for repro zips */
  maxUploadBytes: number
  /** delete finished tasks older than this */
  retentionMs: number
  /** how often the retention sweeper runs */
  cleanupIntervalMs: number
}

export interface Quota {
  /** stored tasks (all statuses) */
  maxTasks: number
  /** total artifact bytes across the user's tasks */
  maxStorageBytes: number
  /** agent generation runs per day */
  maxGenerationsPerDay: number
  /** verifications per day */
  maxVerificationsPerDay: number
  /** captures per day */
  maxCapturesPerDay: number
  /** jobs of one user running at the same time */
  maxConcurrent: number
}

const MB = 1024 * 1024

export const DEFAULT_PLANS: Record<string, Quota> = {
  free: {
    maxTasks: 10,
    maxStorageBytes: 500 * MB,
    maxGenerationsPerDay: 1,
    maxVerificationsPerDay: 20,
    maxCapturesPerDay: 20,
    maxConcurrent: 1,
  },
  pro: {
    maxTasks: 200,
    maxStorageBytes: 20 * 1024 * MB,
    maxGenerationsPerDay: 20,
    maxVerificationsPerDay: 400,
    maxCapturesPerDay: 400,
    maxConcurrent: 2,
  },
  unlimited: {
    maxTasks: 100_000,
    maxStorageBytes: 1024 * 1024 * MB,
    maxGenerationsPerDay: 100_000,
    maxVerificationsPerDay: 100_000,
    maxCapturesPerDay: 100_000,
    maxConcurrent: 8,
  },
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

/**
 * Defaults are the safe ones: no build execution, no private-network access,
 * bearer token required as soon as the server is not bound to loopback.
 */
export function resolveConfig(partial: Partial<ServerConfig> = {}): ServerConfig {
  const host = partial.host ?? '127.0.0.1'
  const token = partial.token ?? process.env.COPYPAGE_TOKEN ?? undefined
  const agentModel = partial.agentModel ?? process.env.COPYPAGE_AGENT_MODEL
  const config: ServerConfig = {
    host,
    port: partial.port ?? 4400,
    dataDir: partial.dataDir ?? 'work/server',
    ...(partial.publicDir ? { publicDir: partial.publicDir } : {}),
    ...(token ? { token } : {}),
    allowPrivateNetwork: partial.allowPrivateNetwork ?? envBool('COPYPAGE_ALLOW_PRIVATE_NETWORK', false),
    allowBuild: partial.allowBuild ?? envBool('COPYPAGE_ALLOW_BUILD', false),
    allowAgent: partial.allowAgent ?? envBool('COPYPAGE_ALLOW_AGENT', false),
    agentCommand: partial.agentCommand ?? process.env.COPYPAGE_AGENT_COMMAND ?? 'pi',
    agentArgs: partial.agentArgs ?? [],
    ...(agentModel ? { agentModel } : {}),
    agentMaxRounds: partial.agentMaxRounds ?? Number(process.env.COPYPAGE_AGENT_MAX_ROUNDS ?? '8'),
    agentTimeoutMs: partial.agentTimeoutMs ?? Number(process.env.COPYPAGE_AGENT_TIMEOUT_MIN ?? '30') * 60_000,
    rateLimitPerMinute: partial.rateLimitPerMinute ?? Number(process.env.COPYPAGE_RATE_LIMIT_PER_MINUTE ?? '120'),
    trustProxy: partial.trustProxy ?? envBool('COPYPAGE_TRUST_PROXY', false),
    allowRegistration: partial.allowRegistration ?? envBool('COPYPAGE_ALLOW_REGISTRATION', false),
    workerConcurrency: partial.workerConcurrency ?? Number(process.env.COPYPAGE_WORKER_CONCURRENCY ?? '2'),
    workerMemoryMb: partial.workerMemoryMb ?? Number(process.env.COPYPAGE_WORKER_MEMORY_MB ?? '3072'),
    plans: partial.plans ?? DEFAULT_PLANS,
    ...(partial.adminEmail ?? process.env.COPYPAGE_ADMIN_EMAIL
      ? { adminEmail: partial.adminEmail ?? process.env.COPYPAGE_ADMIN_EMAIL }
      : {}),
    ...(partial.adminPassword ?? process.env.COPYPAGE_ADMIN_PASSWORD
      ? { adminPassword: partial.adminPassword ?? process.env.COPYPAGE_ADMIN_PASSWORD }
      : {}),
    maxTasks: partial.maxTasks ?? Number(process.env.COPYPAGE_MAX_TASKS ?? '50'),
    maxUploadBytes: partial.maxUploadBytes ?? Number(process.env.COPYPAGE_MAX_UPLOAD_MB ?? '200') * 1024 * 1024,
    retentionMs: partial.retentionMs ?? Number(process.env.COPYPAGE_RETENTION_HOURS ?? '168') * 3600_000,
    cleanupIntervalMs: partial.cleanupIntervalMs ?? 3600_000,
  }

  if (!isLoopbackHost(config.host) && !config.token) {
    throw new Error(
      `refusing to bind ${config.host} without a token — set --token / COPYPAGE_TOKEN, or bind 127.0.0.1`,
    )
  }
  return config
}
