import { createServer, type Server } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
}

export interface StaticServer {
  url: string
  close(): Promise<void>
}

/** Serve a directory over http on a random local port. */
export async function serveStatic(dir: string): Promise<StaticServer> {
  const root = path.resolve(dir)
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
        let file = path.join(root, urlPath)
        if (!file.startsWith(root)) {
          res.writeHead(403).end('forbidden')
          return
        }
        let st = await stat(file).catch(() => null)
        if (st?.isDirectory()) {
          file = path.join(file, 'index.html')
          st = await stat(file).catch(() => null)
        }
        if (!st) {
          res.writeHead(404).end('not found')
          return
        }
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
        res.end(body)
      } catch (err) {
        res.writeHead(500).end(String(err))
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  }
}
