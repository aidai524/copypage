#!/usr/bin/env tsx
import { startServer } from './index.js'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const port = Number(arg('port', '4400'))
const host = arg('host', '127.0.0.1')
const dataDir = arg('data-dir', 'work/server')

const server = await startServer({ port, host, dataDir })
console.log(`CopyPage capture service → ${server.url}`)
console.log(`  data dir: ${dataDir}`)
console.log('  POST /api/tasks   { type: "url", source: "https://…", options? }')
console.log('  GET  /api/tasks   list   |  /api/events SSE  |  /  UI')

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// keep the process alive while the server runs
await new Promise(() => {})
