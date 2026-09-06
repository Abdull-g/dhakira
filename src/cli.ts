#!/usr/bin/env node
// CLI entry point — dhakira init|start|stop|status|reset|extract|help

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  mergeClaudeHooks,
  mergeCodexHooks,
  removeClaudeHooks,
  removeCodexHooks,
} from './hooks/hook-config.js'

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

// ---------------------------------------------------------------------------
// PID helpers
// ---------------------------------------------------------------------------

function pidFilePath(walletDir: string): string {
  return join(walletDir, '.pid')
}

async function readPid(walletDir: string): Promise<number | null> {
  try {
    const raw = await readFile(pidFilePath(walletDir), 'utf8')
    const pid = parseInt(raw.trim(), 10)
    return Number.isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Stdin prompt helper
// ---------------------------------------------------------------------------

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

// ---------------------------------------------------------------------------
// Config loader (lazy — avoids import cost for quick commands)
// ---------------------------------------------------------------------------

async function resolveWalletDir(): Promise<string> {
  try {
    const { loadConfig } = await import('./config/loader.js')
    const result = await loadConfig()
    if (result.ok) return result.value.walletDir
  } catch {
    // Fall through to default
  }
  return join(homedir(), '.dhakira')
}

// ---------------------------------------------------------------------------
// Wallet stats helpers
// ---------------------------------------------------------------------------

/** Counts all .md files under turns/ and extracts unique session IDs. */
async function countTurnsAndSessions(
  walletDir: string,
): Promise<{ turns: number; sessions: number }> {
  try {
    const entries = (await readdir(join(walletDir, 'turns'), { recursive: true })) as string[]
    const mdFiles = entries.filter((f) => f.endsWith('.md'))
    const sessionIds = new Set<string>()
    for (const f of mdFiles) {
      const base = f.includes('/') ? (f.split('/').pop() ?? f) : f
      // Turn files are named "{sessionId}-{turnIndex}.md"
      const match = base.match(/^(.+)-\d+\.md$/)
      const sessionId = match?.[1]
      if (sessionId) sessionIds.add(sessionId)
    }
    return { turns: mdFiles.length, sessions: sessionIds.size }
  } catch {
    return { turns: 0, sessions: 0 }
  }
}

/** Returns the mtime of the most recently written turn file. */
async function getLastCaptureTime(walletDir: string): Promise<Date | null> {
  try {
    const turnsDir = join(walletDir, 'turns')
    const dateDirs = (await readdir(turnsDir)).sort()
    if (dateDirs.length === 0) return null
    const latestDate = dateDirs[dateDirs.length - 1]
    if (!latestDate) return null
    const files = await readdir(join(turnsDir, latestDate))
    const mdFiles = files.filter((f) => f.endsWith('.md'))
    if (mdFiles.length === 0) return null
    let latest: Date | null = null
    for (const f of mdFiles) {
      const s = await stat(join(turnsDir, latestDate, f))
      if (!latest || s.mtime > latest) latest = s.mtime
    }
    return latest
  } catch {
    return null
  }
}

/** Recursively sum file sizes in a directory. */
async function getDirSize(dir: string): Promise<number> {
  try {
    const entries = (await readdir(dir, { recursive: true })) as string[]
    let total = 0
    for (const entry of entries) {
      try {
        const s = await stat(join(dir, entry))
        if (s.isFile()) total += s.size
      } catch {
        // skip unreadable entries
      }
    }
    return total
  } catch {
    return 0
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** Replace home dir prefix with ~ for display. */
function tildePath(p: string): string {
  const home = homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

// ---------------------------------------------------------------------------
// Init helpers
// ---------------------------------------------------------------------------

interface ToolDef {
  envVar: string
  name: string
  provider: 'openai' | 'anthropic'
  baseUrl: string
  displayUrl: string
}

const KNOWN_TOOLS: ToolDef[] = [
  {
    envVar: 'ANTHROPIC_API_KEY',
    name: 'Claude Code',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    displayUrl: 'api.anthropic.com',
  },
  {
    envVar: 'OPENAI_API_KEY',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    displayUrl: 'api.openai.com',
  },
  {
    envVar: 'OPENROUTER_API_KEY',
    name: 'OpenRouter',
    provider: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    displayUrl: 'openrouter.ai',
  },
]

interface LocalServer {
  name: string
  url: string
  baseUrl: string
}

const LOCAL_SERVERS: LocalServer[] = [
  { name: 'Ollama', url: 'http://localhost:11434', baseUrl: 'http://localhost:11434/v1' },
  { name: 'LM Studio', url: 'http://localhost:1234', baseUrl: 'http://localhost:1234/v1' },
  { name: 'LocalAI', url: 'http://localhost:8080', baseUrl: 'http://localhost:8080/v1' },
]

function extractionProviderName(tool: ToolDef): string {
  if (tool.envVar === 'ANTHROPIC_API_KEY') return 'Anthropic'
  return tool.name
}

function extractionModelForTool(tool: ToolDef): string {
  if (tool.envVar === 'ANTHROPIC_API_KEY') return 'claude-3-5-haiku-latest'
  if (tool.envVar === 'OPENROUTER_API_KEY') return 'openai/gpt-4o-mini'
  return 'gpt-4o-mini'
}

/** Probe a local server by hitting a lightweight endpoint. */
async function probeLocalServer(server: LocalServer): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch(`${server.url}/api/version`, { signal: controller.signal }).catch(() =>
      fetch(`${server.url}/v1/models`, { signal: controller.signal }),
    )
    return res.ok || res.status === 401 // 401 means server is there, just needs auth
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function generateConfigYaml(
  detected: ToolDef[],
  localServers: LocalServer[],
  addAnthropicWildcard: boolean,
  addOpenAIWildcard: boolean,
  extractionTool: ToolDef | null,
): string {
  const lines: string[] = ['# Dhakira configuration', '']

  lines.push('capture:')
  lines.push('  pipelineVersion: v2')
  lines.push('  debug: false')
  lines.push('')

  const hasTools =
    detected.length > 0 || localServers.length > 0 || addAnthropicWildcard || addOpenAIWildcard

  if (!hasTools) {
    lines.push('tools:')
    lines.push('  # Cloud providers:')
    lines.push('  # - name: Claude Code')
    lines.push('  #   provider: anthropic')
    lines.push('  #   apiKey: env:ANTHROPIC_API_KEY')
    lines.push('  #   baseUrl: https://api.anthropic.com')
    lines.push('  #')
    lines.push('  # Local models (Ollama, LM Studio, etc.):')
    lines.push('  # - name: Ollama')
    lines.push('  #   provider: openai')
    lines.push('  #   apiKey: "ollama"')
    lines.push('  #   baseUrl: http://localhost:11434/v1')
    lines.push('')
    return lines.join('\n')
  }

  lines.push('tools:')

  for (const t of detected) {
    lines.push(`  - name: ${t.name}`)
    lines.push(`    provider: ${t.provider}`)
    lines.push(`    apiKey: env:${t.envVar}`)
    lines.push(`    baseUrl: ${t.baseUrl}`)
  }

  for (const s of localServers) {
    lines.push(`  - name: ${s.name}`)
    lines.push('    provider: openai')
    lines.push(`    apiKey: "${s.name.toLowerCase().replace(/\s+/g, '-')}"`)
    lines.push(`    baseUrl: ${s.baseUrl}`)
  }

  if (addAnthropicWildcard || addOpenAIWildcard) {
    lines.push('  # Wildcard pass-through for OAuth and non-matching keys.')
  }

  if (addAnthropicWildcard) {
    lines.push('  - name: Claude Code (subscription)')
    lines.push('    provider: anthropic')
    lines.push('    apiKey: "*"')
    lines.push('    baseUrl: https://api.anthropic.com')
  }

  if (addOpenAIWildcard) {
    lines.push('  - name: OpenAI (passthrough)')
    lines.push('    provider: openai')
    lines.push('    apiKey: "*"')
    lines.push('    baseUrl: https://api.openai.com/v1')
  }

  lines.push('')

  if (extractionTool !== null) {
    lines.push('extraction:')
    lines.push(`  model: ${extractionModelForTool(extractionTool)}`)
    lines.push(`  apiKey: env:${extractionTool.envVar}`)
    lines.push(`  baseUrl: ${extractionTool.baseUrl}`)
    lines.push('')
  }

  return lines.join('\n')
}

function generateLaunchdPlist(execPath: string, scriptPath: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>com.dhakira</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${execPath}</string>`,
    `    <string>${scriptPath}</string>`,
    '    <string>start</string>',
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    '  <string>/tmp/dhakira.log</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>/tmp/dhakira.log</string>',
    '</dict>',
    '</plist>',
  ].join('\n')
}

function generateSystemdService(execPath: string, scriptPath: string): string {
  return [
    '[Unit]',
    'Description=Dhakira AI Memory Proxy',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execPath} ${scriptPath} start`,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Hook wiring — Claude Code + Codex adapters
//
// Format-specific merge/remove I/O lives in hooks/hook-config.ts; both tools use
// the same marker guard, command shape, and empty-group cleanup.
// ---------------------------------------------------------------------------

/** Absolute path to the bundled hook script (works for global install and `tsx src/cli.ts` dev). */
function resolveHookScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  if (here.includes(`${sep}dist`) || here.endsWith('dist')) {
    return join(here, 'hooks', 'dhakira-hook.mjs')
  }
  return join(here, '..', 'dist', 'hooks', 'dhakira-hook.mjs')
}

async function commandConnect(tool: string): Promise<void> {
  const t = tool.toLowerCase().trim()

  if (t === 'cursor') {
    console.log(`\n  ${c.yellow('!')}  Cursor wiring is parked for a later ticket.`)
    console.log(`  Supported now: ${c.cyan('claude-code, codex')}\n`)
    return
  }
  if (t !== 'claude-code' && t !== 'claude' && t !== 'codex') {
    console.error(`\n  ${c.red(`Unknown tool: ${tool || '(none)'}`)}`)
    console.log(`  Usage: ${c.cyan('dhakira connect <claude-code|codex>')}\n`)
    process.exit(1)
  }

  const hookPath = resolveHookScriptPath()
  try {
    await stat(hookPath)
  } catch {
    console.log(`\n  ${c.red('✗')} Hook script not found at ${c.dim(hookPath)}`)
    console.log(`  Run ${c.cyan('npm run build')} first, then retry.\n`)
    process.exit(1)
  }

  if (t === 'codex') {
    await mergeCodexHooks(hookPath)
    console.log(`\n  ${c.green('✓')} Codex hooks added ${c.dim('(~/.codex/config.toml)')}`)
    console.log(
      `  ${c.yellow('Required:')} Open Codex, run ${c.cyan('/hooks')}, and trust the two new Dhakira hooks.`,
    )
    console.log(
      `  ${c.dim('Recall injects on each prompt; turns are captured when Codex finishes.')}`,
    )
  } else {
    await mergeClaudeHooks(hookPath)
    console.log(`\n  ${c.green('✓')} Claude Code connected ${c.dim('(~/.claude/settings.json)')}`)
    console.log(
      `  ${c.dim('Recall injects on each prompt; turns are captured when Claude finishes.')}`,
    )
  }
  console.log(`  ${c.dim('Make sure Dhakira is running:')} ${c.cyan('dhakira start')}\n`)
}

async function commandDisconnect(tool: string): Promise<void> {
  const t = tool.toLowerCase().trim()
  if (t !== 'claude-code' && t !== 'claude' && t !== 'codex') {
    console.error(`\n  ${c.red(`Unknown tool: ${tool || '(none)'}`)}`)
    console.log(`  Usage: ${c.cyan('dhakira disconnect <claude-code|codex>')}\n`)
    process.exit(1)
  }
  if (t === 'codex') {
    await removeCodexHooks()
    console.log(`\n  ${c.green('✓')} Removed Dhakira hooks from ~/.codex/config.toml\n`)
  } else {
    await removeClaudeHooks()
    console.log(`\n  ${c.green('✓')} Removed Dhakira hooks from ~/.claude/settings.json\n`)
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function isNpxInvocation(): boolean {
  const execPath = process.argv[1] ?? ''
  // npx puts binaries in a _npx cache dir; global installs go to bin/
  return execPath.includes('_npx')
}

/** Detect if running via npx or as a global install */
function cmdPrefix(): string {
  return isNpxInvocation() ? 'npx dhakira' : 'dhakira'
}

function printHelp(): void {
  const cmd = cmdPrefix()
  const installTip = isNpxInvocation()
    ? `\n  ${c.bold('Tip:')}  Install globally for convenience: ${c.dim('npm install -g dhakira')}\n`
    : ''
  console.log(`
  ${c.bold('dhakira')} — Your AI, with memory.

  ${c.bold('Usage:')}
    ${cmd} [command]

  ${c.bold('Commands:')}
    ${c.cyan('init')}       Set up Dhakira (API key or Claude Max/Pro subscription)
    ${c.cyan('start')}      Start Dhakira (daemon, hooks, dashboard)
    ${c.cyan('stop')}       Stop a running Dhakira instance
    ${c.cyan('status')}     Show current status and statistics
    ${c.cyan('connect')}    Wire tool hooks into Dhakira ("dhakira connect <claude-code|codex>")
    ${c.cyan('disconnect')} Remove tool hooks ("dhakira disconnect <claude-code|codex>")
    ${c.cyan('profile')}    Show your generated memory profile
    ${c.cyan('record')}     Save a fact to your memory ("dhakira record "fact"")
    ${c.cyan('search')}     Search your captured memories ("dhakira search "query"")
    ${c.cyan('extract')}    Regenerate your profile from captured conversations
    ${c.cyan('consolidate')} Distill redundant memories into denser ones
    ${c.cyan('forget')}     Soft-forget expired + aged-superseded memories
    ${c.cyan('doctor')}     Measure recall latency against the 1.5s hook budget
    ${c.cyan('reset')}      Delete your wallet and start fresh
    ${c.cyan('help')}       Show this help message

  ${c.bold('Options:')}
    start -d, --daemon   Run in background (daemon mode)
    start -v, --verbose  Show verbose injection details
${installTip}
  ${c.dim('Docs: https://github.com/Abdull-g/dhakira')}
`)
}

async function commandInit(): Promise<void> {
  const walletDir = join(homedir(), '.dhakira')

  console.log(`\n  ${c.bold('dhakira')} — Your AI, with memory.\n`)

  // Check if already initialized
  try {
    await stat(walletDir)
    const cmd = cmdPrefix()
    console.log(`  ${c.yellow('⚠')}  Wallet already exists at ${c.cyan(tildePath(walletDir))}`)
    console.log(
      `  Run ${c.cyan(`${cmd} start`)} to start, or ${c.cyan(`${cmd} reset`)} to start fresh.\n`,
    )
    return
  } catch {
    // Good — wallet doesn't exist yet
  }

  // Detect API keys
  console.log(`  Checking environment...`)
  const detected: ToolDef[] = []
  for (const tool of KNOWN_TOOLS) {
    if (process.env[tool.envVar]) {
      console.log(
        `  ${c.green('✓')} Found ${tool.envVar} → configured ${c.dim(`(${tool.displayUrl})`)}`,
      )
      detected.push(tool)
    }
  }

  let addAnthropicWildcard = detected.some((tool) => tool.provider === 'anthropic')
  const addOpenAIWildcard = detected.some((tool) => tool.provider === 'openai')
  if (!detected.some((tool) => tool.provider === 'anthropic')) {
    console.log('')
    console.log(`  Do you use Claude Code with a Max/Pro subscription (not API key)?`)
    console.log(`  This adds a pass-through config so Dhakira can proxy your OAuth traffic.`)
    const subscription = await prompt(`  [y/N] › `)
    addAnthropicWildcard = subscription.toLowerCase() === 'y'
  }

  // Detect local model servers
  const detectedLocal: LocalServer[] = []
  for (const server of LOCAL_SERVERS) {
    const alive = await probeLocalServer(server)
    if (alive) {
      console.log(`  ${c.green('✓')} Found ${server.name} → configured ${c.dim(`(${server.url})`)}`)
      detectedLocal.push(server)
    }
  }

  if (detected.length === 0 && detectedLocal.length === 0) {
    console.log(`  ${c.yellow('!')}  No API keys or local model servers found.`)
    console.log(`  ${c.dim('Cloud: set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY')}`)
    console.log(`  ${c.dim('Local: start Ollama, LM Studio, or any OpenAI-compatible server')}`)
    console.log('')
    const proceed = await prompt(`  Continue anyway? [y/N] `)
    if (proceed.toLowerCase() !== 'y') {
      console.log('')
      return
    }
  }

  let extractionTool: ToolDef | null = null
  if (detected.length > 0) {
    const candidate = detected[0]
    const useExternal = await prompt(
      `  For memory synthesis, Dhakira uses a local model by default — fully private, no API calls. We can also use your detected ${extractionProviderName(candidate)} for slightly higher quality (~$0.01/refresh). Use external? [y/N] `,
    )
    if (useExternal.toLowerCase() === 'y') {
      extractionTool = candidate
    }
  } else {
    console.log(
      '  Dhakira will use its built-in local model for memory synthesis (~730MB, downloaded on first use). All private, no cost.',
    )
  }

  // Create wallet directory structure
  await mkdir(walletDir, { recursive: true })
  await mkdir(join(walletDir, 'turns'), { recursive: true })
  await mkdir(join(walletDir, 'conversations'), { recursive: true })
  await mkdir(join(walletDir, 'memories'), { recursive: true })
  await writeFile(
    join(walletDir, 'config.yaml'),
    generateConfigYaml(
      detected,
      detectedLocal,
      addAnthropicWildcard,
      addOpenAIWildcard,
      extractionTool,
    ),
    'utf8',
  )
  console.log(`  ${c.green('✓')} Wallet: ${c.cyan(tildePath(walletDir))}`)

  // Auto-start prompt
  console.log('')
  const autoStart = await prompt(`  Start Dhakira automatically on login? (recommended) [Y/n] `)
  const wantAutoStart = autoStart === '' || autoStart.toLowerCase() === 'y'

  if (wantAutoStart) {
    const os = platform()
    const scriptPath = process.argv[1] ?? ''
    const isCompiled = scriptPath.endsWith('.js')
    const execPath = process.execPath

    try {
      if (os === 'darwin') {
        const plistDir = join(homedir(), 'Library', 'LaunchAgents')
        await mkdir(plistDir, { recursive: true })
        const plistPath = join(plistDir, 'com.dhakira.plist')
        const plist = generateLaunchdPlist(
          isCompiled ? execPath : 'npx',
          isCompiled ? scriptPath : `tsx ${scriptPath}`,
        )
        await writeFile(plistPath, plist, 'utf8')
        spawn('launchctl', ['load', plistPath], { stdio: 'ignore' })
        console.log(`  ${c.green('✓')} Added to login items`)
      } else if (os === 'linux') {
        const serviceDir = join(homedir(), '.config', 'systemd', 'user')
        await mkdir(serviceDir, { recursive: true })
        const servicePath = join(serviceDir, 'dhakira.service')
        const service = generateSystemdService(
          isCompiled ? execPath : 'npx',
          isCompiled ? scriptPath : `tsx ${scriptPath}`,
        )
        await writeFile(servicePath, service, 'utf8')
        spawn('systemctl', ['--user', 'enable', '--now', 'dhakira'], { stdio: 'ignore' })
        console.log(`  ${c.green('✓')} Added to login items`)
      } else {
        console.log(
          `  ${c.dim(`  Auto-start not supported on this platform. Start manually with: ${cmdPrefix()} start`)}`,
        )
      }
    } catch {
      console.log(
        `  ${c.yellow('!')}  Could not set up auto-start. Start manually with: ${cmdPrefix()} start`,
      )
    }
  }

  // Start the proxy
  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig(walletDir)
  if (!configResult.ok) {
    console.log(`  ${c.red('✗')} Failed to load config: ${configResult.error.message}\n`)
    return
  }
  const config = configResult.value

  const hasLocal = detectedLocal.length > 0
  const hasCloud = detected.length > 0

  console.log(`  ${c.bold('Next steps:')}`)
  console.log('')
  console.log(`  ${c.dim('# Connect your tools')}`)
  console.log(`  dhakira connect claude-code`)
  console.log(`  dhakira connect codex`)
  console.log('')
  console.log(`  ${c.dim('# Other tools (base-URL routing)')}`)
  console.log(`  export OPENAI_BASE_URL=http://localhost:4100/v1`)
  console.log('')

  if (hasLocal && !hasCloud) {
    console.log(`
  ${c.green('Full local stack detected.')} Your data never leaves your machine.`)
  } else if (hasLocal && hasCloud) {
    console.log(`
  ${c.dim('Local + cloud tools configured. Dhakira works with both.')}`)
  }

  console.log(`
  ${c.bold('Go build something. Dhakira will remember.')}
`)

  // Start the server (keeps the process alive)
  const { main } = await import('./index.js')
  await main()
}

/** Check if a port is already in use */
async function isPortInUse(port: number, host: string): Promise<boolean> {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.once('listening', () => {
      server.close()
      resolve(false)
    })
    server.listen(port, host)
  })
}

async function commandStart(args: string[]): Promise<void> {
  const daemon = args.includes('-d') || args.includes('--daemon')
  const verbose = args.includes('-v') || args.includes('--verbose')

  // Check if already running before doing anything
  if (!daemon) {
    const walletDir = await resolveWalletDir()
    const pid = await readPid(walletDir)
    if (pid !== null && isProcessRunning(pid)) {
      console.log(`\n  ${c.yellow('Already running.')} ${c.dim(`(PID ${pid})`)}`)
      console.log(
        `  Run ${c.cyan(`${cmdPrefix()} stop`)} first, or ${c.cyan(`${cmdPrefix()} status`)} to check.\n`,
      )
      return
    }
    if (await isPortInUse(4100, '127.0.0.1')) {
      console.log(
        `\n  ${c.yellow('Port 4100 is already in use.')} Something is running on that port.`,
      )
      console.log(`  Run ${c.cyan(`${cmdPrefix()} stop`)} or check what's using it.\n`)
      return
    }
  }

  if (daemon) {
    const scriptPath = process.argv[1] ?? ''
    const isCompiled = scriptPath.endsWith('.js')
    const childArgs = verbose ? ['start', '--verbose'] : ['start']

    // Use a single spawn call to avoid TypeScript overload conflicts.
    const spawnCmd = isCompiled ? process.execPath : 'npx'
    const spawnArgs = isCompiled ? [scriptPath, ...childArgs] : ['tsx', scriptPath, ...childArgs]
    const child = spawn(spawnCmd, spawnArgs, { detached: true, stdio: 'ignore' })

    child.unref()
    const pid = child.pid ?? 0

    // Parent writes PID file immediately so stop/status work right away.
    // The child will overwrite it with the same value when it starts.
    const walletDir = await resolveWalletDir()
    await writeFile(join(walletDir, '.pid'), String(pid), 'utf8').catch(() => {})

    console.log(`\n  Dhakira running in background ${c.dim(`(PID ${pid})`)}\n`)
    return
  }

  if (verbose) {
    process.env.DHAKIRA_VERBOSE = '1'
  }

  // Start main(), which opens the proxy/dashboard handles and keeps the process alive.
  const { main } = await import('./index.js')
  await main()
}

async function commandStop(): Promise<void> {
  const walletDir = await resolveWalletDir()
  const pid = await readPid(walletDir)

  if (pid === null) {
    console.log(`\n  ${c.yellow('Nothing running.')}\n`)
    return
  }

  if (!isProcessRunning(pid)) {
    await unlink(pidFilePath(walletDir)).catch(() => {})
    console.log(`\n  ${c.yellow('Nothing running.')} ${c.dim('(Cleaned up stale PID file.)')}\n`)
    return
  }

  process.kill(pid, 'SIGTERM')
  console.log(`\n  Stopped. Your AI is on its own now.\n`)
}

async function commandStatus(): Promise<void> {
  const walletDir = await resolveWalletDir()
  const pid = await readPid(walletDir)
  const running = pid !== null && isProcessRunning(pid)

  const [{ turns, sessions }, lastCapture, sizeBytes] = await Promise.all([
    countTurnsAndSessions(walletDir),
    getLastCaptureTime(walletDir),
    getDirSize(walletDir),
  ])

  const statusLine = running
    ? `${c.green('running')} ${c.dim(`(localhost:4100)`)}`
    : c.dim('stopped')

  const lastLine = lastCapture ? relativeTime(lastCapture) : c.dim('never')

  console.log(`
  ${c.bold('dhakira')}
  ${c.dim('━━━━━━━')}
  Status:   ${statusLine}
  Wallet:   ${c.cyan(tildePath(walletDir))}
  Sessions: ${c.bold(String(sessions))}
  Turns:    ${c.bold(String(turns))}
  Size:     ${formatBytes(sizeBytes)}
  Last:     ${lastLine}
`)
}

async function commandReset(): Promise<void> {
  const walletDir = await resolveWalletDir()

  const { turns, sessions } = await countTurnsAndSessions(walletDir)

  console.log(`\n  This will delete your wallet at ${c.cyan(tildePath(walletDir))}`)
  if (turns > 0) {
    console.log(
      `  ${c.bold(String(turns))} turn${turns === 1 ? '' : 's'} across ${c.bold(String(sessions))} session${sessions === 1 ? '' : 's'} will be lost.`,
    )
  }
  console.log('')

  const confirm = await prompt(`  Type ${c.bold('"reset"')} to confirm:\n  › `)
  if (confirm !== 'reset') {
    console.log(`\n  ${c.dim('Cancelled.')}\n`)
    return
  }

  // Offer to keep config
  const keepConfig = await prompt(`\n  Keep your config? [Y/n] `)
  const saveConfig = keepConfig === '' || keepConfig.toLowerCase() === 'y'
  let savedConfig: string | null = null

  if (saveConfig) {
    try {
      savedConfig = await readFile(join(walletDir, 'config.yaml'), 'utf8')
    } catch {
      // No config to save
    }
  }

  // Stop if running
  const pid = await readPid(walletDir)
  if (pid !== null && isProcessRunning(pid)) {
    process.kill(pid, 'SIGTERM')
    // Brief wait for graceful shutdown
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
  }

  // Delete wallet
  await rm(walletDir, { recursive: true, force: true })

  // Restore config if requested
  if (saveConfig && savedConfig !== null) {
    await mkdir(walletDir, { recursive: true })
    await writeFile(join(walletDir, 'config.yaml'), savedConfig, 'utf8')
  }

  console.log(`\n  Wallet deleted. Starting fresh.\n`)
}

async function commandExtract(): Promise<void> {
  console.log(`\n${c.bold('Running memory extraction...')}\n`)

  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig()
  if (!configResult.ok) {
    console.error(c.red(`Failed to load config: ${configResult.error.message}`))
    process.exit(1)
  }
  const config = configResult.value

  const { createWalletStore } = await import('./retrieval/store.js')
  const storeResult = await createWalletStore(config.walletDir)
  if (!storeResult.ok) {
    console.error(c.red(`Failed to initialize store: ${storeResult.error.message}`))
    process.exit(1)
  }

  const { runExtraction } = await import('./extraction/runner.js')
  const result = await runExtraction(config.walletDir, storeResult.value, config.extraction)

  if (!result.ok) {
    console.error(c.red(`Extraction failed: ${result.error.message}`))
    process.exit(1)
  }

  const s = result.value
  console.log(`${c.bold('Extraction complete')}
${c.dim('────────────────────────────────')}
  Conversations processed: ${c.bold(String(s.conversationsProcessed))}
  Facts extracted:         ${c.bold(String(s.factsExtracted))}
  Memories created:        ${c.green(String(s.memoriesCreated))}
  Memories updated:        ${c.yellow(String(s.memoriesUpdated))}
  Memories invalidated:    ${c.red(String(s.memoriesInvalidated))}
`)
}

async function commandConsolidate(): Promise<void> {
  console.log(`\n${c.bold('Consolidating memories...')}\n`)

  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig()
  if (!configResult.ok) {
    console.error(c.red(`Failed to load config: ${configResult.error.message}`))
    process.exit(1)
  }
  const config = configResult.value

  const { createWalletStore } = await import('./retrieval/store.js')
  const storeResult = await createWalletStore(config.walletDir)
  if (!storeResult.ok) {
    console.error(c.red(`Failed to initialize store: ${storeResult.error.message}`))
    process.exit(1)
  }

  const { runConsolidation } = await import('./store/consolidate.js')
  const result = await runConsolidation(config.walletDir, storeResult.value, config.extraction)

  if (!result.ok) {
    console.error(c.red(`Consolidation failed: ${result.error.message}`))
    process.exit(1)
  }

  const s = result.value
  console.log(`${c.bold('Consolidation complete')}
${c.dim('────────────────────────────────')}
  Clusters found:      ${c.bold(String(s.clustersFound))}
  Merged:              ${c.green(String(s.merged))}
  Left as-is:          ${c.bold(String(s.leftAsIs))}
  Sources superseded:  ${c.yellow(String(s.sourcesSuperseded))}
`)
}

async function commandForget(): Promise<void> {
  console.log(`\n${c.bold('Forgetting eligible memories...')}\n`)

  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig()
  if (!configResult.ok) {
    console.error(c.red(`Failed to load config: ${configResult.error.message}`))
    process.exit(1)
  }
  const config = configResult.value

  const { createWalletStore } = await import('./retrieval/store.js')
  const storeResult = await createWalletStore(config.walletDir)
  if (!storeResult.ok) {
    console.error(c.red(`Failed to initialize store: ${storeResult.error.message}`))
    process.exit(1)
  }

  const { runForget } = await import('./store/forget.js')
  const result = await runForget(config.walletDir, storeResult.value)

  if (!result.ok) {
    console.error(c.red(`Forget failed: ${result.error.message}`))
    process.exit(1)
  }

  const s = result.value
  console.log(`${c.bold('Forget complete')}
${c.dim('────────────────────────────────')}
  Scanned:             ${c.bold(String(s.scanned))}
  Forgotten:           ${c.green(String(s.forgotten))}
  Expired:             ${c.bold(String(s.byReason.expired))}
  Superseded-aged:     ${c.yellow(String(s.byReason.supersededAged))}
  Skipped (core):      ${c.bold(String(s.skippedCore))}
`)
}

function joinPositional(args: string[]): string {
  return args.join(' ').trim()
}

export async function commandRecord(args: string[]): Promise<void> {
  const factText = joinPositional(args)
  if (factText.length === 0) {
    console.error(c.red('Usage: dhakira record "your fact here"'))
    process.exit(1)
  }

  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig()
  if (!configResult.ok) {
    console.error(c.red(`Failed to load config: ${configResult.error.message}`))
    process.exit(1)
  }

  const { recordTurn } = await import('./capture/record.js')
  const result = await recordTurn(configResult.value.walletDir, factText)
  if (!result.ok) {
    console.error(c.red(`Record failed: ${result.error.message}`))
    process.exit(1)
  }

  const turnPair = result.value
  console.log(
    `✓ Recorded as turn ${turnPair.id.slice(-8)} (turn #${turnPair.turnIndex} in user-records).`,
  )
}

function parseSearchArgs(args: string[]): { query: string; limit: number } {
  const positional: string[] = []
  let limit = 5

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--limit') {
      const parsed = Number.parseInt(args[i + 1] ?? '', 10)
      if (!Number.isNaN(parsed)) limit = Math.min(50, Math.max(1, parsed))
      i++
      continue
    }
    positional.push(arg)
  }

  return { query: joinPositional(positional), limit }
}

function formatSearchTimestamp(timestamp: string): string {
  const d = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function oneLineSnippet(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim()
  return singleLine.length > 200 ? `${singleLine.slice(0, 200).trimEnd()}…` : singleLine
}

export async function commandSearch(args: string[]): Promise<void> {
  const { query, limit } = parseSearchArgs(args)
  if (query.length === 0) {
    console.error(c.red('Usage: dhakira search "query"'))
    process.exit(1)
  }

  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig()
  if (!configResult.ok) {
    console.error(c.red(`Failed to load config: ${configResult.error.message}`))
    process.exit(1)
  }

  const { createWalletStore } = await import('./retrieval/store.js')
  const storeResult = await createWalletStore(configResult.value.walletDir)
  if (!storeResult.ok) {
    console.error(c.red(`Failed to initialize store: ${storeResult.error.message}`))
    process.exit(1)
  }

  const store = storeResult.value
  try {
    const { searchTurns } = await import('./retrieval/search.js')
    const result = await searchTurns(store, { query, limit })
    if (!result.ok) {
      console.error(c.red(`Search failed: ${result.error.message}`))
      process.exit(1)
    }

    if (result.value.length === 0) {
      console.log(c.dim('No matching turns found.'))
      return
    }

    const lines = result.value.map(({ turnPair }) =>
      [
        `${c.dim(`[${formatSearchTimestamp(turnPair.timestamp)}]`)} ${c.cyan(turnPair.tool)} · #${turnPair.id.slice(-6)}`,
        `User: ${oneLineSnippet(turnPair.userContent)}`,
        `Assistant: ${oneLineSnippet(turnPair.assistantContent)}`,
      ].join('\n'),
    )
    console.log(lines.join('\n\n'))
  } finally {
    await store.close()
  }
}

export async function commandProfile(): Promise<void> {
  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig()
  if (!configResult.ok) {
    console.error(c.red(`Failed to load config: ${configResult.error.message}`))
    process.exit(1)
  }

  const walletDir = configResult.value.walletDir
  const { loadProfile } = await import('./injection/profile.js')
  const profileResult = await loadProfile(walletDir)
  if (!profileResult.ok) {
    console.error(c.red(`Failed to load profile: ${profileResult.error.message}`))
    process.exit(1)
  }

  const profile = profileResult.value
  if (profile.trim().length === 0) {
    console.log(
      c.dim(
        'No profile yet. Still learning about you — keep using your AI tools and run `dhakira extract` to generate a profile.',
      ),
    )
    return
  }

  const profilePath = join(walletDir, 'profile.md')
  console.log(`${c.bold('Profile')} ${c.dim(`(${profilePath})`)}\n`)
  console.log(profile)

  try {
    const s = await stat(profilePath)
    console.log(c.dim(`Last updated: ${relativeTime(s.mtime)}`))
  } catch {
    // Missing stat is fine; loadProfile already handled missing-file semantics.
  }
}

// ---------------------------------------------------------------------------
// doctor — recall latency vs the 1.5s hook budget (D2)
// ---------------------------------------------------------------------------

async function commandDoctor(): Promise<void> {
  const { loadConfig } = await import('./config/loader.js')
  const configResult = await loadConfig()
  if (!configResult.ok) {
    console.error(c.red(`Failed to load config: ${configResult.error.message}`))
    process.exit(1)
  }

  const { runDoctor } = await import('./doctor.js')
  const report = await runDoctor({ config: configResult.value })
  const { recall } = report

  const pathLabel: Record<typeof recall.path, string> = {
    daemon: 'daemon /api/recall (hybrid, what a hook sees)',
    hybrid: 'hybrid (in-process)',
    'bm25-deadline': `BM25 — hybrid missed the ${report.hybridDeadlineMs} ms deadline`,
    'bm25-only': 'BM25 only — search models not downloaded',
    error: 'failed',
  }
  const budgetNote = `${c.dim(`(budget ${report.hookBudgetMs} ms · daemon deadline ${report.hybridDeadlineMs} ms)`)}`
  const timeColor = recall.measuredMs < report.hookBudgetMs ? c.green : c.red
  const verdictLine =
    report.verdict === 'pass'
      ? c.green('PASS — recall answers inside the hook budget')
      : c.yellow('WARN — see notes')

  console.log(`
  ${c.bold('dhakira doctor')}
  ${c.dim('━━━━━━━━━━━━━━')}
  Daemon:      ${report.daemonRunning ? c.green('running') : c.dim('stopped')} ${c.dim(`(${configResult.value.dashboard.host}:${configResult.value.dashboard.port})`)}
  Models:      ${report.modelsPresent ? c.green('downloaded') : c.yellow('not downloaded')}
  Resident:    ${report.modelsResident ? c.green('yes') : c.yellow('no')} ${c.dim('(retrieval.modelsResident)')}
  Recall path: ${pathLabel[recall.path]}
  Recall time: ${timeColor(`${recall.measuredMs} ms`)} ${budgetNote}
  Turns found: ${recall.turnCount}${
    report.daemonMetrics
      ? `\n  Timeouts:    ${report.daemonMetrics.recallTimeouts} of ${report.daemonMetrics.recallCount} recalls served by BM25 since daemon start`
      : ''
  }
  Verdict:     ${verdictLine}
`)
  for (const note of report.notes) console.log(`  ${c.dim('•')} ${note}`)
  if (report.notes.length > 0) console.log('')
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const command = process.argv[2] ?? 'help'
  const args = process.argv.slice(3)

  switch (command) {
    case 'init':
      await commandInit()
      break
    case 'start':
      await commandStart(args)
      break
    case 'stop':
      await commandStop()
      break
    case 'status':
      await commandStatus()
      break
    case 'record':
      await commandRecord(args)
      break
    case 'search':
      await commandSearch(args)
      break
    case 'profile':
      await commandProfile()
      break
    case 'reset':
      await commandReset()
      break
    case 'connect':
      await commandConnect(args[0] ?? '')
      break
    case 'disconnect':
      await commandDisconnect(args[0] ?? '')
      break
    case 'extract':
      await commandExtract()
      break
    case 'consolidate':
      await commandConsolidate()
      break
    case 'forget':
      await commandForget()
      break
    case 'doctor':
      await commandDoctor()
      break
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      break
    default:
      console.error(`\n  ${c.red(`Unknown command: ${command}`)}`)
      printHelp()
      process.exit(1)
  }
}

let entryPath = process.argv[1] ?? ''
try {
  entryPath = realpathSync(entryPath)
} catch {
  // Fall back to argv[1] for unusual launchers where the entry path is not on disk.
}

if (import.meta.url === pathToFileURL(entryPath).href) {
  run().catch((err: unknown) => {
    console.error(c.red(`Fatal: ${String(err)}`))
    process.exit(1)
  })
}
