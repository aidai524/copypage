import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiServer } from './api.js'
import { resolveConfig, type ServerConfig } from './config.js'
import { CaptureQueue } from './queue.js'
import { TaskStore } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export type StartServerOptions = Partial<ServerConfig>

export interface RunningServer {
  url: string
  port: number
  config: ServerConfig
  store: TaskStore
  queue: CaptureQueue
  close(): Promise<void>
}

/** Boot the capture/verify service: task store + serial queue + HTTP API/UI. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const dataDir = path.resolve(opts.dataDir ?? 'work/server')
  const config: ServerConfig = { ...resolveConfig(opts), dataDir }
  const publicDir = config.publicDir ?? path.join(here, '..', 'public')

  const store = new TaskStore(dataDir)
  await store.init()
  const queue = new CaptureQueue(store, {
    allowBuild: config.allowBuild,
    repoRoot: path.resolve(here, '../../..'),
    agent: {
      command: config.agentCommand,
      args: config.agentArgs,
      maxRounds: config.agentMaxRounds,
      timeoutMs: config.agentTimeoutMs,
      ...(config.agentModel ? { model: config.agentModel } : {}),
    },
  })
  const server = createApiServer({ store, queue, publicDir, config })

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : config.port

  const sweep = () => {
    void store.cleanupOlderThan(config.retentionMs).catch(() => {})
  }
  sweep()
  const timer = setInterval(sweep, config.cleanupIntervalMs)
  timer.unref()

  return {
    url: `http://${config.host}:${port}`,
    port,
    config,
    store,
    queue,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(timer)
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

export { TaskStore, CaptureQueue }
export * from './types.js'
export { resolveConfig, isLoopbackHost } from './config.js'
export type { ServerConfig } from './config.js'
export { assertPublicUrl, isPrivateAddress, SecurityError } from './security.js'
