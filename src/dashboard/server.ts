// Dashboard HTTP server — serves static files and API routes

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { QMDStore } from '@tobilu/qmd'

import type { WalletConfig } from '../config/schema.js'
import { createLogger } from '../utils/logger.js'
import { createApiHandler } from './api.js'

const log = createLogger('dashboard')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')

import type { ServerResponse } from 'node:http'

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const normalized = urlPath === '/' || !urlPath ? '/index.html' : urlPath
  const filePath = join(PUBLIC_DIR, normalized)

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403)
    res.end()
    return
  }

  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) throw new Error('Not a file')
    const mime = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': mime })
    createReadStream(filePath).pipe(res)
  } catch {
    // SPA fallback — serve index.html for unknown paths
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    createReadStream(join(PUBLIC_DIR, 'index.html')).pipe(res)
  }
}

export function createDashboardServer(config: WalletConfig, store: QMDStore): Server {
  const handleApi = createApiHandler({ config, store })

  return createServer((req, res) => {
    const url = req.url ?? '/'

    if (url.startsWith('/api/')) {
      handleApi(req, res).catch((err: unknown) => {
        log.error('API handler error', { error: String(err) })
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      })
    } else {
      serveStatic(res, url).catch((err: unknown) => {
        log.error('Static file error', { error: String(err) })
        if (!res.headersSent) {
          res.writeHead(500)
          res.end()
        }
      })
    }
  })
}
