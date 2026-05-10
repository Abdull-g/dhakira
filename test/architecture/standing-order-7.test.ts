import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ENGINE_DIRS = ['capture', 'retrieval', 'extraction', 'injection', 'config', 'utils']
const ALLOWED_PROXY_TYPES = new Set(['Result', 'NormalizedMessage'])
const ROOT = process.cwd()

interface Violation {
  file: string
  line: number
  importLine: string
  reason?: string
}

describe('Standing Order #7: engine layer import boundary', () => {
  it('engine code does not import delivery (proxy/dashboard) except for utility types', async () => {
    const violations = await scanEngineForViolations()
    expect(violations, formatViolations(violations)).toEqual([])
  })

  it('classifies allowed and disallowed delivery imports', () => {
    expect(classifyImportLine("import type { Result } from '../proxy/types.js'")).toBeNull()
    expect(
      classifyImportLine("import type { NormalizedMessage } from '../proxy/types.js'"),
    ).toBeNull()
    expect(
      classifyImportLine("import type { Result, NormalizedMessage } from '../proxy/types.js'"),
    ).toBeNull()
    expect(classifyImportLine("type X = import('../proxy/types.js').Result<T>")).toBeNull()

    expect(classifyImportLine("import { Result } from '../proxy/types.js'")).toBe(
      'must be a type-only import of allowed utility types',
    )
    expect(classifyImportLine("import { startProxy } from '../proxy/server.js'")).toBe(
      'proxy import is only allowed from proxy/types.js',
    )
    expect(classifyImportLine("import type { Foo } from '../proxy/server.js'")).toBe(
      'proxy import is only allowed from proxy/types.js',
    )
    expect(classifyImportLine("import type { Foo } from '../dashboard/api.js'")).toBe(
      'dashboard imports are not allowed from engine code',
    )
    expect(classifyImportLine("import type { OtherType } from '../proxy/types.js'")).toBe(
      'only Result and NormalizedMessage may be imported from proxy/types.js',
    )
  })
})

async function scanEngineForViolations(): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const engineDir of ENGINE_DIRS) {
    const dir = join(ROOT, 'src', engineDir)
    const entries = (await readdir(dir, { recursive: true, withFileTypes: true })) as Array<{
      name: string
      parentPath?: string
      path?: string
      isFile(): boolean
    }>

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue

      const parent = entry.parentPath ?? entry.path ?? dir
      const filePath = join(parent, entry.name)
      const source = await readFile(filePath, 'utf8')
      const lines = source.split('\n')

      lines.forEach((line, index) => {
        const reason = classifyImportLine(line)
        if (reason === null) return

        violations.push({
          file: relative(ROOT, filePath),
          line: index + 1,
          importLine: line.trim(),
          reason,
        })
      })
    }
  }

  return violations
}

function classifyImportLine(line: string): string | null {
  const trimmed = line.trim()
  const fromMatch = trimmed.match(/\bfrom\s+['"]((?:\.\.\/)+(proxy|dashboard)\/[^'"]+)['"]/)
  const inlineTypeMatch = trimmed.match(
    /^type\s+.+?=\s*import\(\s*['"]((?:\.\.\/)+(proxy|dashboard)\/[^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/,
  )

  if (inlineTypeMatch) {
    const [, sourcePath, layer, importedName] = inlineTypeMatch
    if (layer === 'dashboard') return 'dashboard imports are not allowed from engine code'
    if (!isProxyTypesPath(sourcePath)) return 'proxy import is only allowed from proxy/types.js'
    return ALLOWED_PROXY_TYPES.has(importedName)
      ? null
      : 'only Result and NormalizedMessage may be imported from proxy/types.js'
  }

  if (!fromMatch) return null

  const [, sourcePath, layer] = fromMatch
  if (layer === 'dashboard') return 'dashboard imports are not allowed from engine code'
  if (!isProxyTypesPath(sourcePath)) return 'proxy import is only allowed from proxy/types.js'

  if (!trimmed.startsWith('import type ')) {
    return 'must be a type-only import of allowed utility types'
  }

  const namesMatch = trimmed.match(/^import\s+type\s+\{([^}]+)\}\s+from\s+['"]/)
  if (!namesMatch?.[1]) return 'must import named utility types from proxy/types.js'

  const importedNames = namesMatch[1].split(',').map((name) => {
    const withoutAlias = name.trim().split(/\s+as\s+/i)[0]
    return withoutAlias.trim()
  })

  return importedNames.every((name) => ALLOWED_PROXY_TYPES.has(name))
    ? null
    : 'only Result and NormalizedMessage may be imported from proxy/types.js'
}

function isProxyTypesPath(sourcePath: string): boolean {
  return /(?:^|\/)proxy\/types\.(?:js|ts)$/.test(sourcePath)
}

function formatViolations(violations: Violation[]): string {
  if (violations.length === 0) return ''

  const lines = violations.map(
    (violation) =>
      `  ${violation.file}:${violation.line} -> ${violation.importLine}${
        violation.reason ? `  (${violation.reason})` : ''
      }`,
  )

  return [
    'Standing Order #7 violation(s):',
    ...lines,
    '',
    'Engine layer (capture, retrieval, extraction, injection, config, utils) must not import',
    'non-utility symbols from the delivery layer (proxy, dashboard). Allowed exceptions:',
    "  - import type { Result } from '../proxy/types.js'",
    "  - import type { NormalizedMessage } from '../proxy/types.js'",
  ].join('\n')
}
