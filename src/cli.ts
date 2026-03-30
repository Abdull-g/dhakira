#!/usr/bin/env node
// CLI entry point — dhakira init|start|stop|status|reset|extract|help

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

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

function generateConfigYaml(detected: ToolDef[], localServers: LocalServer[]): string {
  const lines: string[] = ['# Dhakira configuration', '']

  const hasTools = detected.length > 0 || localServers.length > 0

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

  lines.push('')
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
// Commands
// ---------------------------------------------------------------------------

/** Detect if running via npx or as a global install */
function cmdPrefix(): string {
  const execPath = process.argv[1] ?? ''
  // npx puts binaries in a _npx cache dir; global installs go to bin/
  return execPath.includes('_npx') ? 'npx dhakira' : 'dhakira'
}

function printHelp(): void {
  const cmd = cmdPrefix()
  console.log(`
  ${c.bold('dhakira')} — Your AI, with memory.

  ${c.bold('Usage:')}
    ${cmd} [command]

  ${c.bold('Commands:')}
    ${c.cyan('init')}       Set up Dhakira for the first time
    ${c.cyan('start')}      Start the proxy and dashboard
    ${c.cyan('stop')}       Stop a running Dhakira instance
    ${c.cyan('status')}     Show current status and statistics
    ${c.cyan('reset')}      Delete your wallet and start fresh
    ${c.cyan('help')}       Show this help message

  ${c.bold('Options:')}
    start -d   Run in background (daemon mode)
    start -v   Show verbose injection details

  ${c.bold('Tip:')}  Install globally for convenience: ${c.dim('npm install -g dhakira')}

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

  // Create wallet directory structure
  await mkdir(walletDir, { recursive: true })
  await mkdir(join(walletDir, 'turns'), { recursive: true })
  await mkdir(join(walletDir, 'conversations'), { recursive: true })
  await mkdir(join(walletDir, 'memories'), { recursive: true })
  await writeFile(
    join(walletDir, 'config.yaml'),
    generateConfigYaml(detected, detectedLocal),
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

  console.log(`  ${c.green('✓')} Dhakira is running ${c.dim(`(localhost:${config.proxy.port})`)}`)

  const hasLocal = detectedLocal.length > 0
  const hasCloud = detected.length > 0

  console.log(`
  Point your AI tool to Dhakira:

    Claude Code:   ${c.dim('claude --api-base http://localhost:4100')}
    aider:         ${c.dim('aider --api-base http://localhost:4100')}
    Continue.dev:  ${c.dim('set apiBase to http://localhost:4100 in config')}`)

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
  await import('./index.js')
}

async function commandStart(args: string[]): Promise<void> {
  const daemon = args.includes('-d') || args.includes('--daemon')
  const verbose = args.includes('-v') || args.includes('--verbose')

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
    process.env['DHAKIRA_VERBOSE'] = '1'
  }

  // Importing index.js executes main() which starts the servers and keeps the
  // event loop alive. CLI process stays alive via the open server handles.
  await import('./index.js')
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
    case 'reset':
      await commandReset()
      break
    case 'extract':
      // Hidden command — not shown in help, but functional
      await commandExtract()
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

run().catch((err: unknown) => {
  console.error(c.red(`Fatal: ${String(err)}`))
  process.exit(1)
})
