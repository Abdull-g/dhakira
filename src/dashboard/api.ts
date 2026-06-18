// REST API handler for the dashboard

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import type { QMDStore } from '@tobilu/qmd'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { recordTurn } from '../capture/record.js'
import type { WalletConfig } from '../config/schema.js'
import { runExtraction } from '../extraction/runner.js'
import { ingestTrace } from '../ingest.js'
import type { NormalizedMessage } from '../proxy/types.js'
import { searchTurns } from '../retrieval/search.js'
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

async function getTurnStats(walletDir: string): Promise<{
  turnCount: number
  sessionCount: number
  lastCaptureAt: string | null
  userRecordsCount: number
}> {
  const turnsDir = join(walletDir, 'turns')
  try {
    const entries = (await readdir(turnsDir, { recursive: true })) as string[]
    const turnFiles = entries.filter((f) => String(f).endsWith('.md'))
    const userRecordsCount = turnFiles.filter((f) =>
      /^user-records-\d+\.md$/.test(String(f).split('/').pop() ?? String(f)),
    ).length

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

    return {
      turnCount: turnFiles.length,
      sessionCount: sessionIds.size,
      lastCaptureAt,
      userRecordsCount,
    }
  } catch {
    return { turnCount: 0, sessionCount: 0, lastCaptureAt: null, userRecordsCount: 0 }
  }
}

async function getLastExtractionAt(walletDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(walletDir, '.extraction-state.json'), 'utf8')
    const parsed = JSON.parse(raw) as { lastRunAt?: unknown }
    return typeof parsed.lastRunAt === 'string' ? parsed.lastRunAt : null
  } catch {
    return null
  }
}

async function handleGetStatus(res: ServerResponse, config: WalletConfig): Promise<void> {
  const [{ turnCount, sessionCount, lastCaptureAt, userRecordsCount }, lastExtractionAt] =
    await Promise.all([getTurnStats(config.walletDir), getLastExtractionAt(config.walletDir)])
  sendJson(res, 200, {
    walletDir: config.walletDir,
    incognito: config.incognito,
    toolCount: config.tools.length,
    turnCount,
    sessionCount,
    lastCaptureAt,
    userRecordsCount,
    lastExtractionAt,
  })
}

async function handlePostRecord(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  try {
    const body = await readBody(req)
    const parsed = JSON.parse(body) as { content?: unknown }
    if (typeof parsed.content !== 'string') {
      sendJson(res, 400, { ok: false, error: 'content must be a string' })
      return
    }

    if (parsed.content.trim().length === 0) {
      sendJson(res, 400, { ok: false, error: 'content must be non-empty' })
      return
    }

    if (parsed.content.length > 10_000) {
      sendJson(res, 400, { ok: false, error: 'content exceeds 10000 chars' })
      return
    }

    const result = await recordTurn(deps.config.walletDir, parsed.content, { store: deps.store })
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error.message })
      return
    }

    sendJson(res, 200, { ok: true, turnPair: result.value })
  } catch {
    sendJson(res, 400, { ok: false, error: 'Invalid request body' })
  }
}

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const query = (url.searchParams.get('q') ?? '').trim()
  if (query.length === 0) {
    sendJson(res, 400, { error: 'q parameter is required' })
    return
  }

  const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
  const limit = Number.isNaN(parsedLimit) ? 10 : Math.min(50, Math.max(1, parsedLimit))
  const result = await searchTurns(deps.store, { query, limit })
  if (!result.ok) {
    log.error('Dashboard search failed', { error: result.error.message })
    sendJson(res, 500, { error: result.error.message })
    return
  }

  sendJson(res, 200, { results: result.value })
}

async function handlePostExtract(res: ServerResponse, deps: ApiDeps): Promise<void> {
  const result = await runExtraction(deps.config.walletDir, deps.store, deps.config.extraction)
  if (!result.ok) {
    sendJson(res, 500, { ok: false, error: result.error.message })
    return
  }

  sendJson(res, 200, { ok: true, stats: result.value })
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

/**
 * Defensively coerce an incoming `messages` value into NormalizedMessage[].
 * Returns null only when the value is not an array at all (a hard malformed-body
 * case → 400). Individual malformed entries are skipped, not fatal.
 */
function normalizeIngestMessages(value: unknown): NormalizedMessage[] | null {
  if (!Array.isArray(value)) return null
  const out: NormalizedMessage[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const { role, content } = item as Record<string, unknown>
    if (
      (role === 'user' || role === 'assistant' || role === 'system') &&
      typeof content === 'string'
    ) {
      out.push({ role, content })
    }
  }
  return out
}

/**
 * POST /api/ingest — the generic capture verb. Runs the full hygiene chain via
 * ingestTrace (classify+sanitize+gate ALWAYS run). Honors incognito at the daemon
 * edge (mirrors how the proxy server gates capture). Localhost-only (the dashboard
 * server binds 127.0.0.1). Fail-safe on malformed bodies (400, never throws).
 */
async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  let bodyRaw: string
  try {
    bodyRaw = await readBody(req)
  } catch {
    sendJson(res, 400, { ok: false, captured: false, turnPairs: 0, reason: 'unreadable_body' })
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(bodyRaw)
  } catch {
    sendJson(res, 400, { ok: false, captured: false, turnPairs: 0, reason: 'invalid_json' })
    return
  }

  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >
  const tool = typeof body.tool === 'string' ? body.tool : ''
  const messages = normalizeIngestMessages(body.messages)
  if (messages === null || tool.length === 0) {
    sendJson(res, 400, {
      ok: false,
      captured: false,
      turnPairs: 0,
      reason: 'invalid_body: expected messages[] and tool',
    })
    return
  }

  // Honor incognito: skip capture entirely (no write), same intent as the proxy
  // server not invoking captureConversation when incognito is on.
  if (deps.config.incognito) {
    sendJson(res, 200, { ok: true, captured: false, turnPairs: 0, reason: 'incognito' })
    return
  }

  const result = await ingestTrace(deps, {
    messages,
    tool,
    model: typeof body.model === 'string' ? body.model : undefined,
    projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
    cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
  })
  sendJson(res, 200, result)
}

export interface ApiDeps {
  config: WalletConfig
  store: QMDStore
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function buildRoutes(deps: ApiDeps): Map<string, RouteHandler> {
  const routes = new Map<string, RouteHandler>()
  const config = deps.config
  const w = config.walletDir

  routes.set('GET /api/turns', (_, res) => handleGetTurns(res, w))
  routes.set('GET /api/profile', (_, res) => handleGetProfile(res, w))
  routes.set('GET /api/status', (_, res) => handleGetStatus(res, config))
  routes.set('POST /api/incognito', (req, res) => handleToggleIncognito(req, res, config))
  routes.set('POST /api/record', (req, res) => handlePostRecord(req, res, deps))
  routes.set('GET /api/search', (req, res) => handleSearch(req, res, deps))
  routes.set('POST /api/extract', (_, res) => handlePostExtract(res, deps))
  routes.set('POST /api/ingest', (req, res) => handleIngest(req, res, deps))

  return routes
}

export function createApiHandler(
  deps: ApiDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const routes = buildRoutes(deps)

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
