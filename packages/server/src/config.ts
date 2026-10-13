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
  /** hard cap on stored tasks; new captures are rejected above it */
  maxTasks: number
  /** max upload size for repro zips */
  maxUploadBytes: number
  /** delete finished tasks older than this */
  retentionMs: number
  /** how often the retention sweeper runs */
  cleanupIntervalMs: number
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
