// REST API handler for the dashboard

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type { WalletConfig } from '../config/schema.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('dashboard-api')

interface TurnFrontmatter {
  id: string
  sessionId: string
  tool: string
  timestamp: string
  turnIndex: number
}

export interface ParsedTurn extends TurnFrontmatter {
  userContent: string
  assistantContent: string
}

function parseTurnFile(content: string): ParsedTurn | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?\n?([\s\S]*)$/)
  if (!match?.[1]) return null
  try {
    const fm = parseYaml(match[1]) as Record<string, unknown>
    const body = (match[2] ?? '').trim()
    const userMatch = body.match(/## User\n([\s\S]*?)(?=\n## Assistant|$)/)
    const assistantMatch = body.match(/## Assistant\n([\s\S]*)$/)
    return {
      id: String(fm.id ?? ''),
      sessionId: String(fm.sessionId ?? ''),
      tool: String(fm.tool ?? ''),
      timestamp: String(fm.timestamp ?? ''),
      turnIndex: Number(fm.turnIndex ?? 0),
      userContent: (userMatch?.[1] ?? '').trim(),
      assistantContent: (assistantMatch?.[1] ?? '').trim(),
    }
  } catch {
    return null
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function handleGetTurns(res: ServerResponse, walletDir: string): Promise<void> {
  const turnsDir = join(walletDir, 'turns')
  let files: string[] = []
  try {
    const entries = (await readdir(turnsDir, { recursive: true })) as string[]
    files = entries.filter((f) => String(f).endsWith('.md'))
  } catch {
    sendJson(res, 200, [])
    return
  }
  const turns: ParsedTurn[] = []
  for (const file of files) {
    try {
      const content = await readFile(join(turnsDir, String(file)), 'utf8')
      const parsed = parseTurnFile(content)
      if (parsed) turns.push(parsed)
    } catch {
      // skip unreadable files
    }
  }
  turns.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  sendJson(res, 200, turns)
}

async function handleGetTurn(res: ServerResponse, walletDir: string, id: string): Promise<void> {
  const turnsDir = join(walletDir, 'turns')
  let files: string[] = []
  try {
    const entries = (await readdir(turnsDir, { recursive: true })) as string[]
    files = entries.filter((f) => String(f).endsWith('.md'))
  } catch {
    sendJson(res, 404, { error: 'Turn not found' })
    return
  }
  for (const file of files) {
    try {
      const content = await readFile(join(turnsDir, String(file)), 'utf8')
      const parsed = parseTurnFile(content)
      if (parsed?.id === id) {
        sendJson(res, 200, parsed)
        return
      }
    } catch {
      // skip
    }
  }
  sendJson(res, 404, { error: 'Turn not found' })
}

async function handleGetProfile(res: ServerResponse, walletDir: string): Promise<void> {
  try {
    const content = await readFile(join(walletDir, 'profile.md'), 'utf8')
    sendJson(res, 200, { content })
  } catch {
    sendJson(res, 200, { content: '' })
  }
}

async function handlePutProfile(
  req: IncomingMessage,
  res: ServerResponse,
  walletDir: string,
): Promise<void> {
  try {
    const body = await readBody(req)
    const parsed = JSON.parse(body) as { content?: unknown }
    if (typeof parsed.content !== 'string') {
      sendJson(res, 400, { error: 'content must be a string' })
      return
    }
    await mkdir(walletDir, { recursive: true })
    await writeFile(join(walletDir, 'profile.md'), parsed.content, 'utf8')
    sendJson(res, 200, { ok: true })
  } catch {
    sendJson(res, 400, { error: 'Invalid request body' })
  }
}

async function getTurnStats(
  walletDir: string,
): Promise<{ turnCount: number; sessionCount: number; lastCaptureAt: string | null }> {
  const turnsDir = join(walletDir, 'turns')
  try {
    const entries = (await readdir(turnsDir, { recursive: true })) as string[]
    const turnFiles = entries.filter((f) => String(f).endsWith('.md'))

    const sessionIds = new Set<string>()
    for (const file of turnFiles) {
      const basename = String(file).split('/').pop() ?? String(file)
      const match = basename.match(/^(.+)-\d+\.md$/)
      if (match?.[1]) sessionIds.add(match[1])
    }

    // Use the most recently modified date subdir as a proxy for last capture time
    let lastCaptureAt: string | null = null
    try {
      const dateDirs = (await readdir(turnsDir)).filter((d) =>
        /^\d{4}-\d{2}-\d{2}$/.test(String(d)),
      )
      dateDirs.sort()
      const lastDir = dateDirs[dateDirs.length - 1]
      if (lastDir) {
        const s = await stat(join(turnsDir, String(lastDir)))
        lastCaptureAt = s.mtime.toISOString()
      }
    } catch {
      // no date dirs yet
    }

    return { turnCount: turnFiles.length, sessionCount: sessionIds.size, lastCaptureAt }
  } catch {
    return { turnCount: 0, sessionCount: 0, lastCaptureAt: null }
  }
}

async function handleGetStatus(res: ServerResponse, config: WalletConfig): Promise<void> {
  const { turnCount, sessionCount, lastCaptureAt } = await getTurnStats(config.walletDir)
  sendJson(res, 200, {
    walletDir: config.walletDir,
    incognito: config.incognito,
    toolCount: config.tools.length,
    turnCount,
    sessionCount,
    lastCaptureAt,
  })
}

async function handleToggleIncognito(
  req: IncomingMessage,
  res: ServerResponse,
  config: WalletConfig,
): Promise<void> {
  try {
    const body = await readBody(req)
    const parsed = JSON.parse(body) as { enabled?: unknown }
    if (typeof parsed.enabled !== 'boolean') {
      sendJson(res, 400, { error: 'enabled must be a boolean' })
      return
    }
    config.incognito = parsed.enabled
    const configPath = join(config.walletDir, 'config.yaml')
    let yamlObj: Record<string, unknown> = {}
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed2 = parseYaml(raw)
      if (typeof parsed2 === 'object' && parsed2 !== null && !Array.isArray(parsed2)) {
        yamlObj = parsed2 as Record<string, unknown>
      }
    } catch {
      // No config file yet — write a minimal one
    }
    yamlObj.incognito = parsed.enabled
    await mkdir(config.walletDir, { recursive: true })
    await writeFile(configPath, stringifyYaml(yamlObj), 'utf8')
    sendJson(res, 200, { ok: true, incognito: parsed.enabled })
  } catch (err) {
    log.error('Failed to toggle incognito', { error: String(err) })
    sendJson(res, 400, { error: 'Invalid request body' })
  }
}

export interface ApiDeps {
  config: WalletConfig
  store: QMDStore
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function buildRoutes(config: WalletConfig): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()
  const w = config.walletDir

  routes.set('GET /api/turns', (_, res) => handleGetTurns(res, w))
  routes.set('GET /api/profile', (_, res) => handleGetProfile(res, w))
  routes.set('PUT /api/profile', (req, res) => handlePutProfile(req, res, w))
  routes.set('GET /api/status', (_, res) => handleGetStatus(res, config))
  routes.set('POST /api/incognito', (req, res) => handleToggleIncognito(req, res, config))

  return routes
}

export function createApiHandler(
  deps: ApiDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = buildRoutes(deps.config)

  return async (req, res) => {
    const url = (req.url ?? '/').split('?')[0] ?? '/'
    const method = req.method ?? 'GET'
    const key = `${method} ${url}`

    const staticRoute = routes.get(key)
    if (staticRoute) return staticRoute(req, res)

    const turnMatch = url.match(/^\/api\/turns\/([^/]+)$/)
    if (turnMatch?.[1] && method === 'GET') {
      return handleGetTurn(res, deps.config.walletDir, turnMatch[1])
    }

    sendJson(res, 404, { error: 'Not found' })
  }
}
