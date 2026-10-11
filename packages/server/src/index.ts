import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiServer } from './api.js'
import { CaptureQueue } from './queue.js'
import { TaskStore } from './store.js'

const here = path.dirname(fileURLToPath(import.meta.url))

export interface StartServerOptions {
  /** 0 picks a random free port (used by tests) */
  port?: number
  host?: string
  dataDir?: string
  publicDir?: string
}

export interface RunningServer {
  url: string
  port: number
  store: TaskStore
  queue: CaptureQueue
  close(): Promise<void>
}

/** Boot the capture service: task store + serial queue + HTTP API/UI. */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1'
  const dataDir = path.resolve(opts.dataDir ?? 'work/server')
  const publicDir = opts.publicDir ?? path.join(here, '..', 'public')

  const store = new TaskStore(dataDir)
  await store.init()
  const queue = new CaptureQueue(store)
  const server = createApiServer({ store, queue, publicDir })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4400, host, resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 4400)

  return {
    url: `http://${host}:${port}`,
    port,
    store,
    queue,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}

export { TaskStore, CaptureQueue }
export * from './types.js'
