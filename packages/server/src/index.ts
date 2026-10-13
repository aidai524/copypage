import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiServer } from './api.js'
import { resolveConfig, type ServerConfig } from './config.js'
import { Db } from './db.js'
import { CaptureQueue } from './queue.js'
import { resolveQuotaForOwner } from './quotas.js'
import { importLegacyTasks, TaskStore } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export type StartServerOptions = Partial<ServerConfig>

export interface RunningServer {
  url: string
  port: number
  config: ServerConfig
  db: Db
  store: TaskStore
  queue: CaptureQueue
  close(): Promise<void>
}

/** Boot the capture/verify/generate service: database + worker queue + HTTP API/UI. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const dataDir = path.resolve(opts.dataDir ?? 'work/server')
  const config: ServerConfig = { ...resolveConfig(opts), dataDir }
  const publicDir = config.publicDir ?? path.join(here, '..', 'public')
  const repoRoot = path.resolve(here, '../../..')

  const db = new Db(dataDir)
  const imported = await importLegacyTasks(dataDir, db)
  if (imported > 0) console.log(`[migrate] imported ${imported} task(s) from the pre-SQLite file store`)
  const store = new TaskStore(dataDir, db)
  const queue = new CaptureQueue({
    store,
    repoRoot,
    concurrency: config.workerConcurrency,
    memoryMb: config.workerMemoryMb,
    allowBuild: config.allowBuild,
    agent: {
      command: config.agentCommand,
      args: config.agentArgs,
      maxRounds: config.agentMaxRounds,
      timeoutMs: config.agentTimeoutMs,
      ...(config.agentModel ? { model: config.agentModel } : {}),
    },
    quotaForOwner: (ownerId) => resolveQuotaForOwner(db, ownerId, config),
  })

  const authRequired = () =>
    Boolean(config.token) || Boolean(config.adminEmail) || db.countUsers() > 0

  const server = createApiServer({ store, queue, db, config, publicDir, authRequired })

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : config.port

  const sweep = () => {
    void store.cleanupOlderThan(config.retentionMs).catch(() => {})
    db.pruneSessions()
  }
  sweep()
  const timer = setInterval(sweep, config.cleanupIntervalMs)
  timer.unref()

  return {
    url: `http://${config.host}:${port}`,
    port,
    config,
    db,
    store,
    queue,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(timer)
        server.close((err) => {
          if (err) {
            reject(err)
            return
          }
          db.close()
          resolve()
        })
      }),
  }
}

export { TaskStore, CaptureQueue, Db }
export * from './types.js'
export { resolveConfig, isLoopbackHost } from './config.js'
export type { ServerConfig, Quota } from './config.js'
export { assertPublicUrl, isPrivateAddress, SecurityError } from './security.js'
export { checkQuota, resolveQuota, resolveQuotaForOwner, quotaUsage } from './quotas.js'
export { authenticate, hashPassword, verifyPassword } from './auth.js'
