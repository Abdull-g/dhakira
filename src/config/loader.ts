// Load and validate config.yaml
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parse as parseYaml } from 'yaml'

import type { Result } from '../proxy/types.js'
import { getDefaults } from './defaults.js'
import type { ToolConfig, WalletConfig } from './schema.js'

/** Expand a leading ~ to the user's home directory */
function expandPath(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return homedir() + p.slice(1)
  }
  return p
}

/**
 * Resolve an "env:VAR_NAME" API key to its value.
 * If the variable is not set, returns the original string unchanged — consumers
 * (e.g. the proxy server) handle missing env vars at usage time.
 */
function resolveEnvKey(value: string): string {
  if (value.startsWith('env:')) {
    return process.env[value.slice(4)] ?? value
  }
  return value
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function getString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function getNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback
}

function getBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function parseToolConfig(raw: unknown): ToolConfig | null {
  if (!isRecord(raw)) return null
  const provider = raw.provider
  if (provider !== 'openai' && provider !== 'anthropic') return null
  return {
    name: getString(raw.name, ''),
    provider,
    apiKey: resolveEnvKey(getString(raw.apiKey, '')),
    baseUrl: getString(raw.baseUrl, ''),
  }
}

function parseTools(raw: unknown): ToolConfig[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const tool = parseToolConfig(item)
    return tool !== null ? [tool] : []
  })
}

/**
 * Deep-merge a raw parsed YAML object with the default WalletConfig.
 * Unknown fields are dropped; missing fields fall back to defaults.
 */
function mergeWithDefaults(raw: unknown): WalletConfig {
  const d = getDefaults()
  if (!isRecord(raw)) return d

  const proxyRaw = isRecord(raw.proxy) ? raw.proxy : {}
  const dashRaw = isRecord(raw.dashboard) ? raw.dashboard : {}
  const extractionRaw = isRecord(raw.extraction) ? raw.extraction : {}
  const injectionRaw = isRecord(raw.injection) ? raw.injection : {}

  const walletDir = expandPath(getString(raw.walletDir, d.walletDir))

  return {
    walletDir,
    proxy: {
      port: getNumber(proxyRaw.port, d.proxy.port),
      host: getString(proxyRaw.host, d.proxy.host),
    },
    dashboard: {
      port: getNumber(dashRaw.port, d.dashboard.port),
      host: getString(dashRaw.host, d.dashboard.host),
    },
    tools: parseTools(raw.tools),
    extraction: {
      schedule: getString(extractionRaw.schedule, d.extraction.schedule),
      model: getString(extractionRaw.model, d.extraction.model),
      apiKey: resolveEnvKey(getString(extractionRaw.apiKey, d.extraction.apiKey)),
      baseUrl: getString(extractionRaw.baseUrl, d.extraction.baseUrl),
    },
    injection: {
      maxTokens: getNumber(injectionRaw.maxTokens, d.injection.maxTokens),
      minRelevanceScore: getNumber(injectionRaw.minRelevanceScore, d.injection.minRelevanceScore),
      recencyBoost: getNumber(injectionRaw.recencyBoost, d.injection.recencyBoost),
      maxTurns: getNumber(injectionRaw.maxTurns, d.injection.maxTurns),
    },
    incognito: getBoolean(raw.incognito, d.incognito),
  }
}

/**
 * Load and parse {walletDir}/config.yaml.
 *
 * - If the file does not exist, returns the default config (ok: true).
 * - If the file exists but is malformed, returns ok: false.
 * - env: prefixed API keys are resolved; if the variable is not set, the
 *   original "env:VAR_NAME" string is kept so consumers can detect it.
 */
export async function loadConfig(walletDir?: string): Promise<Result<WalletConfig>> {
  const dir = walletDir !== undefined ? expandPath(walletDir) : join(homedir(), '.dhakira')
  const configPath = join(dir, 'config.yaml')

  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed: unknown = parseYaml(raw)
    return { ok: true, value: mergeWithDefaults(parsed) }
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // No config file — use defaults with the provided walletDir if given
      const defaults = getDefaults()
      return { ok: true, value: { ...defaults, walletDir: dir } }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: err instanceof Error ? err : new Error(message) }
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
