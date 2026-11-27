import { Cluster } from 'ioredis'
import {
  FencingError,
  Idempotency,
  SerializationError,
  type IdempotencyOptions,
  type Outcome,
  type PendingRecord,
} from 'quayside'
import { RedisStorage, type RedisCommandClient } from 'quayside/redis'
import { redisIntegerReply, redisKeyPart, type RedisClient } from './capabilities.js'

export {
  ConcurrentExecutionError,
  FencingError,
  IdempotencyKeyReuseError,
  SerializationError,
  WaitTimeoutError,
} from 'quayside'
export type { ExecuteInput as RedisIdempotencyInput, ExecutionContext as RedisIdempotencyContext } from 'quayside'

export type RedisIdempotencyOptions = Pick<
  IdempotencyOptions, 'namespace' | 'lockTtl' | 'resultTtl' | 'onConflict' | 'waitTimeout' | 'codec'
>

function storageClient(redis: RedisClient): RedisCommandClient {
  const cluster = redis instanceof Cluster
  const keyFor = (key: string) => `idempotency:${key}`
  const scriptArgs = (keyCount: number, args: Array<string | number>) =>
    args.map((value, index) => index < keyCount ? keyFor(String(value)) : value)

  // Quayside encodes its namespace. Qualify the resulting keys before ioredis applies keyPrefix.
  return {
    set: (key, value, px, ttl, nx) => redis.set(keyFor(key), value, px, ttl, nx),
    // A queued Cluster command can be routed again on reconnect. EVAL always targets the primary.
    get: (key) => cluster
      ? redis.eval("return redis.call('GET', KEYS[1])", 1, keyFor(key)) as Promise<string | null>
      : redis.get(keyFor(key)),
    del: (...keys) => redis.del(...keys.map(keyFor)).then(redisIntegerReply),
    eval: (script, keys, ...args) => redis.eval(script, keys, ...scriptArgs(keys, args)).then(redisIntegerReply),
    evalsha: (sha, keys, ...args) => redis.evalsha(sha, keys, ...scriptArgs(keys, args)).then(redisIntegerReply),
  }
}

class RedisIdempotencyStorage extends RedisStorage {
  override async acquire(record: PendingRecord, lockTtlMs: number) {
    const startedAt = performance.now()
    const existing = await super.acquire(record, lockTtlMs)
    if ((existing === null || existing.token === record.token) && performance.now() - startedAt >= lockTtlMs) {
      // A queued acquisition can have reached Redis recently, leaving a live reservation to release.
      await super.release(record.key, record.token).catch(() => {})
      throw new FencingError(record.key)
    }
    return existing
  }

  override async complete(key: string, token: string, outcome: Outcome, resultTtlMs: number): Promise<void> {
    const encoded = outcome.status === 'completed' ? outcome.result : outcome.error
    if (typeof encoded !== 'string' || /[\uD800-\uDFFF]/u.test(encoded)) {
      throw new SerializationError('Idempotency codec must return a lossless UTF-8 string')
    }
    try {
      await super.complete(key, token, outcome, resultTtlMs)
    } catch (error) {
      if (!(error instanceof FencingError)) throw error

      // A resent completion can have already stored its outcome before the connection dropped.
      const record = await this.get(key)
      if (!record || record.token !== token || record.status !== outcome.status) throw error
      const saved = outcome.status === 'completed' ? record.result : record.error
      if (saved !== encoded) throw error
    }
  }
}

export function createRedisIdempotency(
  redis: RedisClient,
  options: RedisIdempotencyOptions = {},
): Idempotency {
  const { namespace = 'default', lockTtl, resultTtl, onConflict, waitTimeout, codec } = options
  if (onConflict !== undefined && onConflict !== 'reject' && onConflict !== 'wait') {
    throw new TypeError('onConflict must be reject or wait')
  }
  if (codec !== undefined && (typeof codec?.encode !== 'function' || typeof codec?.decode !== 'function')) {
    throw new TypeError('codec must provide encode and decode functions')
  }
  return new Idempotency({
    lockTtl,
    resultTtl,
    onConflict,
    waitTimeout,
    codec,
    namespace: redisKeyPart(namespace, 'namespace'),
    onStorageError: 'closed',
    storage: new RedisIdempotencyStorage(storageClient(redis), { subscribe: false }),
  })
}
