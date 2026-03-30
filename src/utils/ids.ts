// ID generation utilities
import { randomBytes } from 'node:crypto'

/** Generate a prefixed random ID (e.g., "conv_a1b2c3") */
export function generateId(prefix: string): string {
  const hex = randomBytes(6).toString('hex')
  return `${prefix}_${hex}`
}
