// Structured logging utility

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
}

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export function createLogger(module: string, minLevel: LogLevel = 'info'): Logger {
  const minLevelNum = LEVELS[minLevel]

  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < minLevelNum) return

    // info and debug are silent in the CLI — runtime events are emitted via
    // explicit process.stdout.write() calls in the hot path instead.
    if (level === 'info' || level === 'debug') return

    // Warn and error go to stderr as readable text (no JSON blobs).
    const dataStr = data ? ` ${JSON.stringify(data)}` : ''
    process.stderr.write(`[${module}] ${level}: ${msg}${dataStr}\n`)
  }

  return {
    debug: (msg, data) => log('debug', msg, data),
    info: (msg, data) => log('info', msg, data),
    warn: (msg, data) => log('warn', msg, data),
    error: (msg, data) => log('error', msg, data),
  }
}
