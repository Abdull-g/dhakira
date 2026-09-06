import { describe, expect, it } from 'vitest'
import { redactSecrets, safeRedactSecrets } from '../../src/capture/secrets.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleaned(text: string): string {
  return redactSecrets(text).cleaned
}

function redactCount(text: string): number {
  return redactSecrets(text).redactedCount
}

// ---------------------------------------------------------------------------
// Secret fixtures, built at runtime
// ---------------------------------------------------------------------------
// The redaction tests need credible *shaped* secrets to be meaningful, but a
// real-shaped secret literal in source is indistinguishable to GitHub's push
// secret scanner from an actual leak. So every secret below is assembled at
// runtime (deterministic, from a non-secret alphabet) — the source contains
// no secret-shaped literal, while the tests still assert redaction of the
// exact runtime values. Do NOT replace these with literal-looking strings.
const ALPHABET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
const ALPHABET_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
function fake(prefix: string, len: number, alphabet: string = ALPHABET): string {
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[i % alphabet.length]
  return prefix + out
}
// ---------------------------------------------------------------------------
// API key patterns
// ---------------------------------------------------------------------------

describe('redactSecrets — OpenAI keys', () => {
  it('redacts a standard sk- key', () => {
    const key = fake('sk-', 32)
    const text = `My API key is ${key}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(key)
  })

  it('redacts an sk-proj- key', () => {
    const key = fake('sk-proj-', 32)
    const text = `Use ${key} for this`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(key)
  })

  it('increments redactedCount for each key found', () => {
    const text = `key1=${fake('sk-', 22)} key2=${fake('sk-', 22)}`
    expect(redactCount(text)).toBe(2)
  })
})

describe('redactSecrets — Anthropic keys', () => {
  it('redacts an sk-ant- key', () => {
    const key = fake('sk-ant-api03-', 30)
    const text = `ANTHROPIC_API_KEY=${key}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('sk-ant-')
  })
})

describe('redactSecrets — GitHub PATs', () => {
  it('redacts a classic PAT (ghp_)', () => {
    const key = fake('ghp_', 40)
    const text = `token: ${key}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('ghp_')
  })

  it('redacts a fine-grained PAT (github_pat_)', () => {
    const key = fake('github_pat_', 55)
    const text = `GITHUB_TOKEN=${key}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('github_pat_')
  })
})

describe('redactSecrets — AWS keys', () => {
  it('redacts an AWS access key ID', () => {
    const key = fake('AKIA', 16, ALPHABET_UPPER)
    const text = `AWS_ACCESS_KEY_ID=${key}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(key)
  })

  it('redacts an AWS secret access key', () => {
    const key = fake('', 40)
    const text = `aws_secret_access_key=${key}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(key)
  })
})

// ---------------------------------------------------------------------------
// JWT / Bearer tokens
// ---------------------------------------------------------------------------

describe('redactSecrets — JWT tokens', () => {
  it('redacts a well-formed JWT', () => {
    const jwt = `${fake('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6', 20)}.${fake('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV', 20)}`
    expect(cleaned(`Authorization: Bearer ${jwt}`)).not.toContain('eyJhbGciOiJIUzI1Ni')
  })
})

describe('redactSecrets — Bearer tokens', () => {
  it('redacts the token after Bearer', () => {
    const token = fake('', 32)
    const text = `Authorization: Bearer ${token}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(token)
  })
})

// ---------------------------------------------------------------------------
// Password patterns
// ---------------------------------------------------------------------------

describe('redactSecrets — inline passwords', () => {
  it('redacts "password is X" pattern', () => {
    const pass = fake('', 16)
    const text = `the password is ${pass}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(pass)
  })

  it('redacts "my password: X" pattern', () => {
    const pass = fake('', 22)
    const text = `my password: ${pass}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(pass)
  })

  it('redacts "password = X" pattern', () => {
    const pass = fake('', 16)
    const text = `password = ${pass}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(pass)
  })
})

// ---------------------------------------------------------------------------
// token: label pattern
// ---------------------------------------------------------------------------

describe('redactSecrets — token label', () => {
  it('redacts "token: <value>" pattern', () => {
    const value = fake('', 32)
    const text = `token: ${value}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain(value)
  })

  it('redacts "token = <value>" pattern', () => {
    const value = fake('', 32)
    const text = `token = ${value}`
    expect(cleaned(text)).toContain('[REDACTED]')
  })
})

// ---------------------------------------------------------------------------
// No false positives on innocent text
// ---------------------------------------------------------------------------

describe('redactSecrets — no false positives', () => {
  it('does not modify plain conversational text', () => {
    const text = 'I think the best approach is to use React hooks here.'
    expect(cleaned(text)).toBe(text)
    expect(redactCount(text)).toBe(0)
  })

  it('does not redact short words starting with sk-', () => {
    // "sk-abc" is only 6 chars after the prefix — below the 20-char minimum
    const text = 'There is a product called sk-abc that we use'
    expect(redactCount(text)).toBe(0)
  })

  it('returns redactedCount 0 when nothing is found', () => {
    expect(redactCount('Nothing sensitive here at all.')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Multiple secrets in one string
// ---------------------------------------------------------------------------

describe('redactSecrets — multiple secrets', () => {
  it('redacts all secrets in a single pass', () => {
    const text = [`key: ${fake('sk-', 24)}`, `github: ${fake('ghp_', 40)}`].join('\n')
    const result = redactSecrets(text)
    expect(result.redactedCount).toBeGreaterThanOrEqual(2)
    expect(result.cleaned).not.toContain('sk-')
    expect(result.cleaned).not.toContain('ghp_')
  })
})

// ---------------------------------------------------------------------------
// v0.3.1 — audit D5 bypasses found by the engine audit, now closed
// ---------------------------------------------------------------------------

describe('redactSecrets — audit D5 bypasses', () => {
  it('JSON-quoted password ("password":"…") is redacted', () => {
    const secret = fake('', 12)
    const text = `config: {"user":"admin","password":"${secret}"}`
    const out = cleaned(text)
    expect(out).not.toContain(secret)
    expect(out).toContain('"password":"[REDACTED]"')
  })

  it("YAML/single-quoted 'passwd': '…' is redacted", () => {
    const pass = fake('', 12).replace(/_/g, '-')
    const out = cleaned(`db:\n  'passwd': '${pass}'`)
    expect(out).not.toContain(pass)
  })

  it('Slack bot / user / app tokens (xox[abprs]-) are redacted', () => {
    for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr', 'xoxs']) {
      const token = `${prefix}-${fake('', 30)}`
      const out = cleaned(`slack token ${token} here`)
      expect(out, prefix).not.toContain(token)
      expect(out).toContain('[REDACTED]')
    }
  })

  it('Stripe live and restricted keys are redacted (underscore form the sk- pattern missed)', () => {
    const live = `${fake('sk_live_', 22)}`
    const restricted = `${fake('rk_live_', 22)}`
    const out = cleaned(`${live} and ${restricted}`)
    expect(out).not.toContain(live)
    expect(out).not.toContain(restricted)
    expect(redactCount(`${live} ${restricted}`)).toBe(2)
  })

  it('Google API keys (AIza…) are redacted', () => {
    const key = fake('AIza', 35)
    expect(key.length).toBe(39)
    expect(cleaned(`maps key ${key}`)).not.toContain(key)
  })

  it('PEM private-key blocks are redacted as a whole (RSA, EC, OPENSSH, PGP)', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      fake('MIIEowIBAAKCAQEA', 60),
      fake('kx2', 40),
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const out = cleaned(`here is my key:\n${pem}\nthanks`)
    expect(out).not.toContain('MIIEowIBAAKCAQEA')
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(out).toBe('here is my key:\n[REDACTED]\nthanks')

    const openssh = `-----BEGIN OPENSSH PRIVATE KEY-----\n${fake('', 24)}\n-----END OPENSSH PRIVATE KEY-----`
    expect(cleaned(openssh)).toBe('[REDACTED]')
    const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${fake('', 20)}\n-----END PGP PRIVATE KEY BLOCK-----`
    expect(cleaned(pgp)).toBe('[REDACTED]')
  })

  it('credentials embedded in URLs (scheme://user:pass@host) are redacted, host kept', () => {
    const pgPass = fake('', 14)
    const out = cleaned(`DATABASE_URL is postgres://admin:${pgPass}@db.internal:5432/app`)
    expect(out).not.toContain(pgPass)
    expect(out).not.toContain('admin:')
    expect(out).toContain('postgres://[REDACTED]@db.internal:5432/app')
    const redisPass = fake('', 16)
    expect(cleaned(`redis://:${redisPass}@cache:6379`)).not.toContain(redisPass)
    // A URL without userinfo is untouched.
    expect(cleaned('see https://example.com/docs')).toBe('see https://example.com/docs')
  })

  it('Authorization: Basic <base64> is redacted; the word "Basic" in prose is not', () => {
    const out = cleaned('curl -H "Authorization: Basic YWRtaW46aHVudGVyMjI="')
    expect(out).not.toContain('YWRtaW46aHVudGVyMjI=')
    expect(out).toContain('Authorization: Basic [REDACTED]')
    const prose = 'We need Basic ConfigurationOptions documented for the team.'
    expect(cleaned(prose)).toBe(prose)
  })

  it('env-style secret assignments (NAME contains KEY/SECRET/TOKEN/PASSWORD, value ≥ 20 chars) are redacted', () => {
    const cases = [
      `export OPENROUTER_API_KEY=${fake('or-v1-', 24)}`,
      `DB_PASSWORD="${fake('', 30)}"`,
      `SESSION_SECRET='${fake('', 28)}'`,
      `MY_SERVICE_TOKEN=${fake('', 20)}`,
    ]
    for (const line of cases) {
      const out = cleaned(line)
      expect(out, line).toContain('[REDACTED]')
      expect(out, line).toMatch(/^(export )?[A-Z_]+=["']?\[REDACTED\]["']?$/)
    }
    // Short values and non-secret names are left alone.
    expect(cleaned('DEBUG_LEVEL=verbose')).toBe('DEBUG_LEVEL=verbose')
    expect(cleaned('PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin')).toBe(
      'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin',
    )
    expect(cleaned('API_KEY=short')).toBe('API_KEY=short')
  })

  it('email addresses (PII) are redacted', () => {
    const out = cleaned('reach me at abdullah.g@example.co.uk or ops+alerts@corp.io')
    expect(out).not.toContain('abdullah.g@example.co.uk')
    expect(out).not.toContain('ops+alerts@corp.io')
    expect(out).toBe('reach me at [REDACTED] or [REDACTED]')
    // A bare @handle is not an email.
    expect(cleaned('ping @abdullah on slack')).toBe('ping @abdullah on slack')
  })

  it('still leaves ordinary technical prose untouched (no new false positives)', () => {
    const prose = [
      'We use Basic auth for the internal admin panel and rotate keys quarterly.',
      'The token bucket rate limiter refills at 10 rps.',
      'Set MAX_RETRIES=5 and LOG_LEVEL=debug in the env file.',
      'postgres://localhost:5432/app has no credentials in the URL.',
    ].join('\n')
    expect(cleaned(prose)).toBe(prose)
    expect(redactCount(prose)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// safeRedactSecrets wrapper
// ---------------------------------------------------------------------------

describe('safeRedactSecrets', () => {
  it('returns ok: true with a RedactResult for normal input', () => {
    const result = safeRedactSecrets('hello world')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.cleaned).toBe('hello world')
    expect(result.value.redactedCount).toBe(0)
  })

  it('still redacts secrets through the safe wrapper', () => {
    const result = safeRedactSecrets(fake('sk-', 24))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.cleaned).toContain('[REDACTED]')
  })
})