import { describe, expect, it } from 'vitest'
import { redactSecrets, safeRedactSecrets } from '../../src/capture/secrets.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleaned(text: string): string {
  return redactSecrets(text).cleaned
}

function count(text: string): number {
  return redactSecrets(text).redactedCount
}

// ---------------------------------------------------------------------------
// API key patterns
// ---------------------------------------------------------------------------

describe('redactSecrets — OpenAI keys', () => {
  it('redacts a standard sk- key', () => {
    const text = 'My API key is sk-abcdefghijklmnopqrstuvwxyz123456'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456')
  })

  it('redacts an sk-proj- key', () => {
    const text = 'Use sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789 for this'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('sk-proj-')
  })

  it('increments redactedCount for each key found', () => {
    const text = 'key1=sk-aaaaaaaaaaaaaaaaaaaaaa key2=sk-bbbbbbbbbbbbbbbbbbbbbb'
    expect(count(text)).toBe(2)
  })
})

describe('redactSecrets — Anthropic keys', () => {
  it('redacts an sk-ant- key', () => {
    const text = 'ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('sk-ant-')
  })
})

describe('redactSecrets — GitHub PATs', () => {
  it('redacts a classic PAT (ghp_)', () => {
    const text = 'token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('ghp_')
  })

  it('redacts a fine-grained PAT (github_pat_)', () => {
    const text = `GITHUB_TOKEN=github_pat_${'A'.repeat(55)}`
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('github_pat_')
  })
})

describe('redactSecrets — AWS keys', () => {
  it('redacts an AWS access key ID', () => {
    const text = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('redacts an AWS secret access key', () => {
    const text = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('wJalrXUtnFEMI')
  })
})

// ---------------------------------------------------------------------------
// JWT / Bearer tokens
// ---------------------------------------------------------------------------

describe('redactSecrets — JWT tokens', () => {
  it('redacts a well-formed JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(cleaned(`Authorization: Bearer ${jwt}`)).not.toContain(
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    )
  })
})

describe('redactSecrets — Bearer tokens', () => {
  it('redacts the token after Bearer', () => {
    const text = 'Authorization: Bearer supersecrettoken1234567890abcdef'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('supersecrettoken1234567890abcdef')
  })
})

// ---------------------------------------------------------------------------
// Password patterns
// ---------------------------------------------------------------------------

describe('redactSecrets — inline passwords', () => {
  it('redacts "password is X" pattern', () => {
    const text = 'the password is hunter2secure'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('hunter2secure')
  })

  it('redacts "my password: X" pattern', () => {
    const text = 'my password: correcthorsebatterystaple'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('correcthorsebatterystaple')
  })

  it('redacts "password = X" pattern', () => {
    const text = 'password = S3cr3tP@ssw0rd'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('S3cr3tP@ssw0rd')
  })
})

// ---------------------------------------------------------------------------
// token: label pattern
// ---------------------------------------------------------------------------

describe('redactSecrets — token label', () => {
  it('redacts "token: <value>" pattern', () => {
    const text = 'token: abcdefghijklmnopqrstuvwxyz1234567890'
    expect(cleaned(text)).toContain('[REDACTED]')
    expect(cleaned(text)).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890')
  })

  it('redacts "token = <value>" pattern', () => {
    const text = 'token = abcdefghijklmnopqrstuvwxyz1234567890'
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
    expect(count(text)).toBe(0)
  })

  it('does not redact short words starting with sk-', () => {
    // "sk-abc" is only 6 chars after the prefix — below the 20-char minimum
    const text = 'There is a product called sk-abc that we use'
    expect(count(text)).toBe(0)
  })

  it('returns redactedCount 0 when nothing is found', () => {
    expect(count('Nothing sensitive here at all.')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Multiple secrets in one string
// ---------------------------------------------------------------------------

describe('redactSecrets — multiple secrets', () => {
  it('redacts all secrets in a single pass', () => {
    const text = [
      'key: sk-aaaaaaaaaaaaaaaaaaaaaaaa',
      'github: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk',
    ].join('\n')

    const result = redactSecrets(text)
    expect(result.redactedCount).toBeGreaterThanOrEqual(2)
    expect(result.cleaned).not.toContain('sk-aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(result.cleaned).not.toContain('ghp_')
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
    const result = safeRedactSecrets('sk-aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.cleaned).toContain('[REDACTED]')
  })
})
