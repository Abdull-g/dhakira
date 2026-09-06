import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// v0.3.1 (audit D10): the guard now covers EVERY engine directory plus the
// root-level engine verbs, not just the four the original ticket named.
const ENGINE_DIRS = [
  'capture',
  'retrieval',
  'extraction',
  'injection',
  'config',
  'utils',
  'store',
  'salience',
  'synthesis',
  'harness',
  'hooks',
]
/** Root-level engine modules (src/*.ts). index.ts + cli.ts are composition roots and exempt. */
const ENGINE_ROOT_FILES = ['ingest.ts', 'recall.ts', 'doctor.ts']
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
    // Root-level engine files import with a single './' — same rules apply.
    expect(
      classifyImportLine("import { computeContextFingerprint } from './proxy/fingerprint.js'"),
    ).toBe('proxy import is only allowed from proxy/types.js')
    expect(classifyImportLine("import type { NormalizedRequest } from './proxy/types.js'")).toBe(
      'only Result and NormalizedMessage may be imported from proxy/types.js',
    )
    expect(
      classifyImportLine("import type { NormalizedMessage } from './proxy/types.js'"),
    ).toBeNull()
    expect(classifyImportLine("type Result<T> = import('./proxy/types.js').Result<T>")).toBeNull()
  })

  it('the guard actually covers the audited violation sites (ingest.ts, recall.ts) and every engine dir', () => {
    expect(ENGINE_ROOT_FILES).toEqual(expect.arrayContaining(['ingest.ts', 'recall.ts']))
    expect(ENGINE_DIRS).toEqual(
      expect.arrayContaining(['store', 'salience', 'synthesis', 'harness', 'hooks']),
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
      violations.push(...(await scanFile(join(parent, entry.name))))
    }
  }

  for (const rootFile of ENGINE_ROOT_FILES) {
    violations.push(...(await scanFile(join(ROOT, 'src', rootFile))))
  }

  return violations
}

async function scanFile(filePath: string): Promise<Violation[]> {
  const violations: Violation[] = []
  const source = await readFile(filePath, 'utf8')
  source.split('\n').forEach((line, index) => {
    const reason = classifyImportLine(line)
    if (reason === null) return
    violations.push({
      file: relative(ROOT, filePath),
      line: index + 1,
      importLine: line.trim(),
      reason,
    })
  })
  return violations
}

function classifyImportLine(line: string): string | null {
  const trimmed = line.trim()
  // `../` (engine subdirectories) or `./` (root-level engine files).
  const fromMatch = trimmed.match(/\bfrom\s+['"]((?:\.{1,2}\/)+(proxy|dashboard)\/[^'"]+)['"]/)
  const inlineTypeMatch = trimmed.match(
    /^type\s+.+?=\s*import\(\s*['"]((?:\.{1,2}\/)+(proxy|dashboard)\/[^'"]+)['"]\s*\)\.([A-Za-z_$][\w$]*)/,
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
    `Engine layer (${ENGINE_DIRS.join(', ')}; src/${ENGINE_ROOT_FILES.join(', src/')}) must not import`,
    'non-utility symbols from the delivery layer (proxy, dashboard). Allowed exceptions:',
    "  - import type { Result } from '../proxy/types.js'",
    "  - import type { NormalizedMessage } from '../proxy/types.js'",
  ].join('\n')
}
