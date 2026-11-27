import { createHash, randomUUID } from 'node:crypto'
import { Limiter } from 'redlimit'
import { assertPositiveInteger, redisIntegerReply, redisKeyPart, type RedisClient } from './capabilities.js'

type RateLimitPolicy =
  | { readonly algorithm?: 'fixed-window' | 'sliding-window'; readonly windowMs: number }
  | {
    readonly algorithm: 'token-bucket'
    readonly refill: { readonly amount: number; readonly intervalMs: number }
  }

export type RedisRateLimitOptions = RateLimitPolicy & {
  readonly name: string
  readonly limit: number
}

export interface RedisRateLimitResult {
  readonly allowed: boolean
  readonly limit: number
  readonly remaining: number
  readonly resetAt: number
  readonly retryAfterMs: number
}

export interface RedisRateLimiter {
  consume(subject: string, options?: { readonly dryRun?: boolean }): Promise<RedisRateLimitResult>
}

const slide = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current = redis.call('TIME')
local now = current[1] * 1000 + math.floor(current[2] / 1000)
if now > 9007199254740991 - window then
  return redis.error_reply('Rate limit window exceeds safe millisecond timestamps')
end

local cutoff = now - window
local start = '(' .. cutoff
local count = redis.call('ZCOUNT', key, start, '+inf')
local allowed = count < limit
local dryRun = ARGV[3] == '1'

if allowed and not dryRun then
  redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
  if redis.call('ZADD', key, 'NX', now, ARGV[4]) == 1 then
    -- An earlier hit can have a later deadline after a Redis clock rollback.
    if redis.call('PTTL', key) < window then
      redis.call('PEXPIRE', key, window)
    end
    count = count + 1
  end
elseif not dryRun then
  -- Redis may have admitted this command before the client lost its reply.
  local score = redis.call('ZSCORE', key, ARGV[4])
  allowed = score and tonumber(score) > cutoff
end

local offset = math.max(0, count - limit)
local oldest = redis.call('ZRANGEBYSCORE', key, start, '+inf', 'WITHSCORES', 'LIMIT', offset, 1)
local reset = oldest[2] and tonumber(oldest[2]) + window or now
return { allowed and 1 or 0, math.max(0, limit - count), reset, now }
`

const tokenBucket = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local idleTtl = tonumber(ARGV[3])
local dryRun = ARGV[4] == '1'

local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local balance = tonumber(bucket[1]) or capacity
local previous = tonumber(bucket[2]) or now
-- Keep the refill origin across Redis clock rollback, including after failover.
local refillFrom = math.max(now, previous)
if refillFrom > 9007199254740991 - idleTtl then
  return redis.error_reply('Token bucket lifetime exceeds safe millisecond timestamps')
end
balance = math.min(capacity, balance + (refillFrom - previous) * refillPerMs)
local allowed = balance >= 1

if allowed and not dryRun then
  balance = balance - 1
  redis.call('HSET', key, 'tokens', string.format('%.17g', balance), 'ts', string.format('%.0f', refillFrom))
  redis.call('PEXPIRE', key, refillFrom - now + idleTtl)
end

local missing = (allowed and capacity or 1) - balance
local reset = missing > 0 and (refillFrom + math.ceil(missing / refillPerMs)) or now
return { allowed and 1 or 0, math.floor(balance), reset, now }
`

const tokenBucketDigest = createHash('sha1').update(tokenBucket).digest('hex')

async function evalTokenBucket(redis: RedisClient, key: string, ...args: (number | string)[]): Promise<unknown> {
  try {
    return await redis.evalsha(tokenBucketDigest, 1, key, ...args)
  } catch (error) {
    if (!(error instanceof Error && /^(?:ERR )?NOSCRIPT(?:\s|$)/.test(error.message))) throw error
    return redis.eval(tokenBucket, 1, key, ...args)
  }
}

function toRateLimitResult(reply: unknown, limit: number): RedisRateLimitResult {
  if (!Array.isArray(reply) || reply.length !== 4) throw new TypeError('Unexpected Redis rate limit reply')
  const [status, remaining, reset, now] = reply.map(redisIntegerReply)
  const allowed = status === 1
  const resetAfterMs = reset - now
  const resetAt = Date.now() + resetAfterMs
  return { allowed, limit, remaining, resetAt, retryAfterMs: allowed ? 0 : resetAfterMs }
}

function createConsume(
  redis: RedisClient,
  options: RedisRateLimitOptions,
): (subjectKey: string, dryRun: boolean) => Promise<RedisRateLimitResult> {
  const { name, limit, algorithm = 'fixed-window' } = options
  const prefix = `rate-limit:${algorithm}:${redisKeyPart(name, 'name')}`
  assertPositiveInteger(limit, 'limit')

  if (options.algorithm === 'sliding-window') {
    const { windowMs } = options
    assertPositiveInteger(windowMs, 'windowMs')
    return async (subjectKey, dryRun) => {
      const key = `${prefix}:${subjectKey}`
      const reply = await redis.eval(slide, 1, key, limit, windowMs, dryRun ? '1' : '0', dryRun ? '' : randomUUID())
      return toRateLimitResult(reply, limit)
    }
  }

  if (options.algorithm === 'token-bucket') {
    const { amount, intervalMs } = options.refill
    assertPositiveInteger(amount, 'refill.amount')
    assertPositiveInteger(intervalMs, 'refill.intervalMs')
    const refillPerMs = amount / intervalMs
    const idleTtl = Math.ceil(limit / refillPerMs) + 1_000
    assertPositiveInteger(idleTtl, 'token bucket TTL')
    return async (subjectKey, dryRun) => {
      const key = `${prefix}:{${subjectKey}}`
      const reply = await evalTokenBucket(redis, key, limit, refillPerMs, idleTtl, dryRun ? '1' : '0')
      return toRateLimitResult(reply, limit)
    }
  }

  if (algorithm !== 'fixed-window') throw new TypeError(`Unsupported rate limit algorithm: ${algorithm}`)
  assertPositiveInteger(options.windowMs, 'windowMs')
  const limiter = new Limiter({ redis, limit, prefix, algorithm, window: `${options.windowMs}ms`, fail: 'closed' })

  return async (subjectKey, dryRun) => {
    const result = await (dryRun ? limiter.peek(subjectKey) : limiter.limit(subjectKey))
    const { success: allowed, remaining, reset: resetAt } = result
    return { allowed, limit, remaining, resetAt, retryAfterMs: allowed ? 0 : Math.max(0, resetAt - Date.now()) }
  }
}

export function createRedisRateLimiter(redis: RedisClient, options: RedisRateLimitOptions): RedisRateLimiter {
  const consume = createConsume(redis, options)
  return {
    async consume(subject, { dryRun = false } = {}) {
      if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean')
      return consume(redisKeyPart(subject, 'subject'), dryRun)
    },
  }
}
