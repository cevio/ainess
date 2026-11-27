import { createHash } from 'node:crypto'
import type { Cluster, Redis } from 'ioredis'

export type RedisClient = Redis | Cluster

export function redisKeyPart(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  // Preserve unpaired surrogates as their original code units.
  return createHash('sha256').update(value, 'utf16le').digest('hex')
}

export function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
}

export function redisIntegerReply(value: unknown): number {
  const result = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value
  if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
    throw new TypeError('Unexpected Redis integer reply')
  }
  return result
}
