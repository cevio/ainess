import { setTimeout as delay } from 'node:timers/promises'
import {
  createLock,
  executeWithSingleLockExtension,
  IoredisAdapter,
  LockAcquisitionError,
  type ExtendedAbortSignal,
} from 'redlock-universal'
import { assertPositiveInteger, redisIntegerReply, redisKeyPart, type RedisClient } from './capabilities.js'

export { LockAcquisitionError } from 'redlock-universal'

export interface RedisLockOptions {
  readonly ttlMs: number
  readonly retryAttempts?: number
  readonly retryDelayMs?: number
  readonly fencing?: boolean
}

export interface RedisLockLease {
  readonly fencingToken: string | undefined
  renew(): Promise<boolean>
  release(): Promise<boolean>
}

export interface RedisLockScope {
  readonly signal: AbortSignal
  readonly fencingToken: string | undefined
}

export interface RedisLock {
  tryAcquire(): Promise<RedisLockLease | undefined>
  withLock<T>(task: (scope: RedisLockScope) => T | Promise<T>): Promise<T>
}

export class RedisLockOwnershipLostError extends Error {
  constructor(readonly key: string, cause?: unknown) {
    super(`Redis lock lease lost for "${key}"`, { cause })
    this.name = 'RedisLockOwnershipLostError'
  }
}

const acquireLease = `
local owner = redis.call('GET', KEYS[1])
if owner and owner ~= ARGV[1] then return false end
if not owner then
  if KEYS[2] then redis.call('INCR', KEYS[2]) end
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
end
if KEYS[2] then return redis.call('GET', KEYS[2]) end
return 'OK'
`

const renewalExpired = {
  resultCode: 0,
  actualTTL: 0,
  message: 'Redis did not confirm renewal before the lease expired',
} as const

class LeaseAdapter extends IoredisAdapter {
  acquisitionStartedAt = 0
  busy = false
  fencingToken?: string
  releaseOutcome?: { released: boolean } | { error: unknown }
  private acquiredValue?: string
  private confirmedUntil = 0

  constructor(private readonly redis: RedisClient, private readonly fencing: boolean) {
    super(redis)
  }

  protected override scriptCalls(script: string, keys: string[], args: (string | number)[]) {
    const calls = super.scriptCalls(script, keys, args)
    const parse = (reply: unknown) => Array.isArray(reply) ? reply.map(redisIntegerReply) : redisIntegerReply(reply)
    return {
      evalSha: (sha: string) => calls.evalSha(sha).then(parse),
      evalScript: () => calls.evalScript().then(parse),
    }
  }

  override async setNX(key: string, value: string, ttl: number): Promise<string | null> {
    this.acquisitionStartedAt = performance.now()
    this.busy = false
    const keys = this.fencing ? [key, `${key}:fence`] : [key]
    // ioredis can resend the same acquisition after a disconnect.
    const reply = await this.withTimeout(this.redis.eval(acquireLease, keys.length, ...keys, value, ttl))
    if (reply === null) {
      this.busy = true
      return null
    }
    if (typeof reply !== 'string') throw new TypeError('Unexpected Redis lock reply')

    this.acquiredValue = value
    this.confirmedUntil = this.acquisitionStartedAt + ttl
    this.fencingToken = this.fencing ? reply : undefined
    this.releaseOutcome = undefined
    return 'OK'
  }

  override async atomicExtend(key: string, value: string, minTTL: number, ttl: number) {
    const startedAt = performance.now()
    const deadline = this.confirmedUntil
    const remaining = Math.ceil(deadline - startedAt)
    if (remaining <= 0) return renewalExpired

    const timer = new AbortController()
    try {
      const result = await Promise.race([
        super.atomicExtend(key, value, Math.max(1, minTTL), ttl),
        delay(remaining, renewalExpired, { signal: timer.signal, ref: false }),
      ])
      if (performance.now() >= deadline) return renewalExpired
      if (result.resultCode === 1) this.confirmedUntil = startedAt + ttl
      return result
    } finally {
      timer.abort()
    }
  }

  override async delIfMatch(key: string, value: string): Promise<boolean> {
    // The auto-extension helper waits for release and reports cleanup failures only to its logger.
    try {
      const released = await super.delIfMatch(key, value)
      if (value === this.acquiredValue) this.releaseOutcome = { released }
      return released
    } catch (error) {
      if (value === this.acquiredValue) this.releaseOutcome = { error }
      throw error
    }
  }
}

export function createRedisLock(redis: RedisClient, key: string, options: RedisLockOptions): RedisLock {
  const lockKey = `lock:{${redisKeyPart(key, 'key')}}`
  const { ttlMs, retryAttempts = 0, retryDelayMs = 100, fencing = false } = options
  assertPositiveInteger(ttlMs, 'ttlMs')
  assertPositiveInteger(retryDelayMs, 'retryDelayMs')
  if (ttlMs > 2_147_483_647 || retryDelayMs > 2_147_483_647) {
    throw new RangeError('ttlMs and retryDelayMs must fit in a Node.js timer')
  }
  if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 0) {
    throw new RangeError('retryAttempts must be a non-negative safe integer')
  }

  const createLease = (attempts: number) => {
    const adapter = new LeaseAdapter(redis, fencing)
    const lock = createLock({
      adapter,
      key: lockKey,
      ttl: ttlMs,
      retryAttempts: attempts,
      retryDelay: retryDelayMs,
      circuitBreaker: false,
    })
    return { adapter, lock }
  }

  return {
    async tryAcquire() {
      const { adapter, lock } = createLease(0)
      try {
        const handle = await lock.acquire()
        return {
          fencingToken: adapter.fencingToken,
          renew: async () => {
            const startedAt = performance.now()
            const renewed = await lock.extend(handle, ttlMs)
            return renewed && performance.now() - startedAt < ttlMs
          },
          release: () => lock.release(handle),
        }
      } catch (error) {
        if (error instanceof LockAcquisitionError && adapter.busy) return undefined
        throw error
      }
    },

    async withLock(task) {
      const { adapter, lock } = createLease(retryAttempts)
      const handle = await lock.acquire()
      // The extension helper expects an epoch timestamp. Preserve the monotonic age of the winning attempt.
      const acquiredAt = Date.now() - Math.ceil(performance.now() - adapter.acquisitionStartedAt)
      let signal: ExtendedAbortSignal | undefined
      const result = await executeWithSingleLockExtension(lock, { ...handle, acquiredAt }, ttlMs, async (leaseSignal) => {
        signal = leaseSignal
        return task({ signal: leaseSignal, fencingToken: adapter.fencingToken })
      })
      const outcome = adapter.releaseOutcome
      if (signal?.aborted || (outcome && 'released' in outcome && !outcome.released)) {
        throw new RedisLockOwnershipLostError(key, signal?.error ?? signal?.reason)
      }
      if (outcome && 'error' in outcome) throw outcome.error
      return result
    },
  }
}
