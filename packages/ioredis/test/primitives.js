import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { redisKeyPart } from '../dist/capabilities.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {import('ioredis').Redis | import('ioredis').Cluster} client
 */
export async function testRedisPrimitives(t, client) {
  await t.test('fenced and regular leases contend for the same key and a stale holder cannot release it', async () => {
    const { createRedisLock } = await import('@ainess/ioredis/lock')
    const key = 'orders:{north}:42'
    const lock = createRedisLock(client, key, { ttlMs: 300, fencing: true })
    const plain = createRedisLock(client, key, { ttlMs: 3_000 })
    const expired = await lock.tryAcquire()
    assert.ok(expired)
    assert.equal(expired.fencingToken, '1')
    assert.equal(await plain.tryAcquire(), undefined)
    assert.equal(await expired.renew(), true)

    await delay(375)
    const current = await createRedisLock(client, key, { ttlMs: 3_000, fencing: true }).tryAcquire()
    assert.ok(current)
    assert.equal(current.fencingToken, '2')
    assert.equal(await expired.renew(), false)
    assert.equal(await expired.release(), false)
    assert.equal(await plain.tryAcquire(), undefined)
    assert.equal(await current.release(), true)

    const result = await lock.withLock(async ({ signal, fencingToken }) => {
      assert.equal(signal.aborted, false)
      assert.equal(fencingToken, '3')
      assert.equal(await plain.tryAcquire(), undefined)
      return 'complete'
    })
    assert.equal(result, 'complete')
    const released = await plain.tryAcquire()
    assert.ok(released)
    assert.equal(await released.release(), true)
  })

  for (const fencing of [false, true]) {
    await t.test(`a resent acquisition preserves the lease with fencing=${fencing}`, async (subtest) => {
      const { createRedisLock } = await import('@ainess/ioredis/lock')
      const lock = createRedisLock(client, `resent-lease:${fencing}`, { ttlMs: 5_000, fencing })
      const sendSet = client.set.bind(client)
      const sendEval = client.eval.bind(client)
      let resends = 0

      /**
       * @param {string} key
       * @param {string} value
       * @param {'PX'} px
       * @param {number} ttl
       * @param {'NX'} nx
       */
      const replaySet = async (key, value, px, ttl, nx) => {
        const reply = await sendSet(key, value, px, ttl, nx)
        if (reply !== 'OK') return reply
        resends++
        await client.pexpire(key, 3_000)
        return sendSet(key, value, px, ttl, nx)
      }
      /**
       * @param {string} script
       * @param {number} keyCount
       * @param {...(string | number | Buffer)} args
       */
      const replayEval = async (script, keyCount, ...args) => {
        const reply = await sendEval(script, keyCount, ...args)
        if (typeof args[0] !== 'string' || typeof reply !== 'string') return reply
        resends++
        await client.pexpire(args[0], 3_000)
        const replayed = await sendEval(script, keyCount, ...args)
        assert.ok(await client.pttl(args[0]) <= 3_000)
        return replayed
      }
      subtest.mock.method(client, 'set', replaySet)
      subtest.mock.method(client, 'eval', replayEval)

      const lease = await lock.tryAcquire()
      assert.equal(resends, 1)
      assert.ok(lease)
      assert.equal(lease.fencingToken, fencing ? '1' : undefined)
      assert.equal(await lease.release(), true)
    })
  }

  await t.test('manual renewal reports an acknowledgement that outlives the renewed lease', async (subtest) => {
    const { createRedisLock } = await import('@ainess/ioredis/lock')
    const lock = createRedisLock(client, 'late-renewal', { ttlMs: 300 })
    const acquisition = subtest.mock.method(client, 'eval')
    const lease = await lock.tryAcquire()
    assert.ok(lease)
    assert.equal(await lease.renew(), true)
    const key = acquisition.mock.calls[0]?.arguments[2]
    assert.ok(typeof key === 'string')
    const sendEvalSha = client.evalsha.bind(client)
    /**
     * @param {string} script
     * @param {number} keyCount
     * @param {...(string | number | Buffer)} args
     */
    const delayRenewalReply = async (script, keyCount, ...args) => {
      const reply = await sendEvalSha(script, keyCount, ...args)
      assert.equal(reply, 1)
      await delay(375)
      assert.equal(await client.pttl(key), -2)
      return reply
    }
    const evalSha = subtest.mock.method(client, 'evalsha', delayRenewalReply, { times: 1 })

    assert.equal(await lease.renew(), false)
    assert.equal(evalSha.mock.callCount(), 1)
    const replacement = await lock.tryAcquire()
    assert.ok(replacement)
    assert.equal(await lease.release(), false)
    assert.equal(await replacement.release(), true)
  })

  await t.test('withLock reports a lost lease even if the callback returns successfully', async (subtest) => {
    const { createRedisLock, RedisLockOwnershipLostError } = await import('@ainess/ioredis/lock')
    const lock = createRedisLock(client, 'lost-lease', { ttlMs: 3_000, fencing: true })
    const evalScript = subtest.mock.method(client, 'eval')
    await assert.rejects(lock.withLock(async () => {
      const key = evalScript.mock.calls[0]?.arguments[2]
      assert.ok(typeof key === 'string')
      assert.equal(await client.del(key), 1)
      return 'expired'
    }), RedisLockOwnershipLostError)
  })

  await t.test('withLock retains the reason for a failed renewal', async (subtest) => {
    const { createRedisLock, RedisLockOwnershipLostError } = await import('@ainess/ioredis/lock')
    const lock = createRedisLock(client, 'failed-renewal', { ttlMs: 500, fencing: true })
    const evalScript = subtest.mock.method(client, 'eval')
    await assert.rejects(lock.withLock(async ({ signal }) => {
      const key = evalScript.mock.calls[0]?.arguments[2]
      assert.ok(typeof key === 'string')
      assert.equal(await client.del(key), 1)
      if (!signal.aborted) await once(signal, 'abort', { signal: AbortSignal.timeout(3_000) })
      return 'lease lost'
    }), (error) => {
      assert.ok(error instanceof RedisLockOwnershipLostError)
      assert.ok(error.cause instanceof Error)
      assert.match(error.cause.message, /Failed to extend/)
      return true
    })
  })

  await t.test('withLock renews on time when the host clock rolls back during acquisition', async (subtest) => {
    const { createRedisLock } = await import('@ainess/ioredis/lock')
    const lock = createRedisLock(client, 'host-clock-rollback', { ttlMs: 700 })
    const now = Date.now
    const sendEval = client.eval.bind(client)
    /**
     * @param {string} script
     * @param {number} keyCount
     * @param {...(string | number | Buffer)} args
     */
    const acquireBeforeClockChange = async (script, keyCount, ...args) => {
      const reply = await sendEval(script, keyCount, ...args)
      assert.equal(reply, 'OK')
      subtest.mock.method(Date, 'now', () => now() - 60_000)
      return reply
    }
    subtest.mock.method(client, 'eval', acquireBeforeClockChange, { times: 1 })

    const result = await lock.withLock(async ({ signal }) => {
      await delay(900)
      assert.equal(signal.aborted, false)
      const competing = await lock.tryAcquire()
      if (competing) await competing.release()
      assert.equal(competing, undefined)
      return 'held'
    })
    assert.equal(result, 'held')
  })

  await t.test('withLock aborts when Redis has not confirmed renewal by the lease deadline', async (subtest) => {
    const { createRedisLock, RedisLockOwnershipLostError } = await import('@ainess/ioredis/lock')
    const lock = createRedisLock(client, 'unconfirmed-renewal', { ttlMs: 500 })
    let announceRenewal = () => {}
    let resumeRenewal = () => {}
    const renewStarted = new Promise((resolve) => { announceRenewal = () => resolve(undefined) })
    const renewReady = new Promise((resolve) => { resumeRenewal = () => resolve(undefined) })
    const sendEvalSha = client.evalsha.bind(client)
    /**
     * @param {string} script
     * @param {number} keyCount
     * @param {...(string | number | Buffer)} args
     */
    const holdRenewal = async (script, keyCount, ...args) => {
      if (args.length === 4) {
        announceRenewal()
        await renewReady
      }
      return sendEvalSha(script, keyCount, ...args)
    }
    subtest.mock.method(client, 'evalsha', holdRenewal)

    await assert.rejects(lock.withLock(async ({ signal }) => {
      try {
        await renewStarted
        if (!signal.aborted) await once(signal, 'abort', { signal: AbortSignal.timeout(400) })
      } finally {
        resumeRenewal()
      }
    }), (error) => {
      assert.ok(error instanceof RedisLockOwnershipLostError)
      assert.ok(error.cause instanceof Error)
      assert.match(error.cause.message, /confirm renewal before the lease expired/)
      return true
    })
    const replacement = await lock.tryAcquire()
    assert.ok(replacement)
    assert.equal(await replacement.release(), true)
  })

  await t.test('the three limiters enforce one quota per subject and dry runs leave the quota available', async () => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const configs = /** @type {const} */ ([
      { algorithm: 'fixed-window', windowMs: 3_600_000 },
      { algorithm: 'sliding-window', windowMs: 3_600_000 },
      { algorithm: 'token-bucket', refill: { amount: 4, intervalMs: 3_600_000 } },
    ])
    for (const config of configs) {
      const limiter = createRedisRateLimiter(client, { name: 'order.create', limit: 4, ...config })
      assert.equal((await limiter.consume('tenant:{north}', { dryRun: true })).remaining, 4)
      const results = await Promise.all(Array.from({ length: 16 }, () => limiter.consume('tenant:{north}')))
      assert.equal(results.filter(({ allowed }) => allowed).length, 4, config.algorithm)
      const rejected = results.find(({ allowed }) => !allowed)
      assert.ok(rejected)
      assert.equal(rejected.remaining, 0)
      assert.ok(rejected.retryAfterMs > 0)
      assert.equal((await limiter.consume('tenant:{south}')).remaining, 3)
    }
  })

  await t.test('invalid dry-run flags fail instead of reading quota without a charge', async () => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const configs = /** @type {const} */ ([
      { algorithm: 'fixed-window', windowMs: 3_600_000 },
      { algorithm: 'sliding-window', windowMs: 3_600_000 },
      { algorithm: 'token-bucket', refill: { amount: 1, intervalMs: 3_600_000 } },
    ])
    for (const config of configs) {
      const limiter = createRedisRateLimiter(client, { name: 'invalid-dry-run', limit: 1, ...config })
      await assert.rejects(
        // @ts-expect-error An untyped caller may pass a string from configuration.
        limiter.consume('tenant', { dryRun: 'false' }),
        { name: 'TypeError', message: /dryRun/ },
      )
      assert.equal((await limiter.consume('tenant')).allowed, true)
    }
  })

  await t.test('all rate limit reset timestamps use the caller clock when Redis has a different time', async (subtest) => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const now = Date.now
    subtest.mock.method(Date, 'now', () => now() + 120_000)
    const policies = /** @type {const} */ ([
      { algorithm: 'fixed-window', windowMs: 3_600_000 },
      { algorithm: 'sliding-window', windowMs: 60_000 },
      { algorithm: 'token-bucket', refill: { amount: 1, intervalMs: 60_000 } },
    ])
    for (const policy of policies) {
      const limiter = createRedisRateLimiter(client, { ...policy, name: 'different-clock', limit: 1 })
      assert.equal((await limiter.consume('tenant')).allowed, true)
      const before = Date.now()
      const denied = await limiter.consume('tenant', { dryRun: true })
      const after = Date.now()
      assert.equal(denied.allowed, false)
      assert.ok(denied.retryAfterMs > 0)
      assert.ok(denied.resetAt - denied.retryAfterMs >= before, policy.algorithm)
      assert.ok(denied.resetAt - denied.retryAfterMs <= after, policy.algorithm)
    }
  })

  await t.test('the token bucket keeps its refill origin and TTL after Redis clock rollback', async () => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const name = 'bucket-clock-rollback'
    const subject = 'orders'
    const intervalMs = 500
    const rollbackMs = 30_000
    const limiter = createRedisRateLimiter(client, {
      name, limit: 2, algorithm: 'token-bucket', refill: { amount: 1, intervalMs },
    })
    const key = `rate-limit:token-bucket:${redisKeyPart(name, 'name')}:{${redisKeyPart(subject, 'subject')}}`
    assert.equal((await limiter.consume(subject)).remaining, 1)
    const [seconds, micros] = await client.time()
    const now = Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000)
    const refillFrom = now + rollbackMs
    await client.hset(key, 'ts', String(refillFrom))
    await client.pexpire(key, rollbackMs + 2 * intervalMs)

    const used = await limiter.consume(subject)
    assert.equal(used.allowed, true)
    assert.equal(used.remaining, 0)
    assert.equal(await client.hget(key, 'ts'), String(refillFrom))
    assert.ok(await client.pttl(key) > rollbackMs / 2)
    const blocked = await limiter.consume(subject, { dryRun: true })
    assert.equal(blocked.allowed, false)
    assert.ok(blocked.retryAfterMs > rollbackMs / 2)
    assert.equal(await client.hget(key, 'ts'), String(refillFrom))

    await client.hset(key, 'ts', String(now - intervalMs))
    assert.equal((await limiter.consume(subject)).allowed, true)
  })

  await t.test('the exact window discounts each expired hit without charging a dry run', async (subtest) => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const evalScript = subtest.mock.method(client, 'eval')
    const windowMs = 60_000
    const limiter = createRedisRateLimiter(client, { name: 'precise', limit: 2, algorithm: 'sliding-window', windowMs })
    await limiter.consume('orders')
    await limiter.consume('orders')
    const key = evalScript.mock.calls[0]?.arguments[2]
    assert.ok(typeof key === 'string')
    const [member] = await client.zrange(key, 0, -1)
    const [seconds, micros] = await client.time()
    await client.zadd(key, Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000) - windowMs - 1, member)

    const probe = await limiter.consume('orders', { dryRun: true })
    assert.equal(probe.allowed, true)
    assert.equal(probe.remaining, 1)
    assert.equal(await client.zcard(key), 2)
    assert.equal((await limiter.consume('orders')).remaining, 0)
    assert.equal((await limiter.consume('orders')).allowed, false)
  })

  await t.test('the exact window preserves live hits when the Redis clock moves backwards', async (subtest) => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const evalScript = subtest.mock.method(client, 'eval')
    const windowMs = 60_000
    const limiter = createRedisRateLimiter(client, {
      name: 'clock-rollback', limit: 2, algorithm: 'sliding-window', windowMs,
    })
    await limiter.consume('orders')
    const key = evalScript.mock.calls[0]?.arguments[2]
    assert.ok(typeof key === 'string')
    const [member] = await client.zrange(key, 0, -1)
    const [seconds, micros] = await client.time()
    const now = Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000)
    const rollbackMs = 30_000
    await client.zadd(key, now + rollbackMs, member)
    await client.pexpire(key, windowMs + rollbackMs)

    assert.equal((await limiter.consume('orders')).allowed, true)
    assert.ok(await client.pttl(key) > windowMs + rollbackMs / 2)
    assert.equal((await limiter.consume('orders')).allowed, false)
  })

  await t.test('the exact window recognizes a resent admission without counting it twice', async (subtest) => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const evalScript = subtest.mock.method(client, 'eval')
    for (const limit of [1, 2]) {
      const limiter = createRedisRateLimiter(client, {
        name: 'replay', limit, algorithm: 'sliding-window', windowMs: 60_000,
      })
      const subject = `customer:${limit}`
      assert.equal((await limiter.consume(subject)).remaining, limit - 1)
      const invocation = evalScript.mock.calls.at(-1)?.arguments
      assert.ok(invocation)
      const key = invocation[2]
      const member = invocation[6]
      assert.ok(typeof key === 'string' && typeof member === 'string')
      const originalScore = Number(await client.zscore(key, member)) - 1_000
      await client.zadd(key, originalScore, member)

      const replay = await client.eval(...invocation)
      assert.ok(Array.isArray(replay))
      assert.deepEqual(replay.slice(0, 2), [1, limit - 1])
      assert.equal(await client.zcard(key), 1)
      assert.equal(await client.zscore(key, member), String(originalScore))
    }
  })

  await t.test('idempotency replays results and rejects conflicting payloads and expired completions', async () => {
    const { createRedisIdempotency, FencingError, IdempotencyKeyReuseError } = await import('@ainess/ioredis/idempotency')
    const idempotency = createRedisIdempotency(client, { lockTtl: 300, resultTtl: 5_000 })
    const operation = { key: 'orders:42', payload: { quantity: 1 } }
    let announceStart = () => {}
    let finishExecution = () => {}
    const started = new Promise((resolve) => { announceStart = () => resolve(undefined) })
    const finish = new Promise((resolve) => { finishExecution = () => resolve(undefined) })
    const expired = idempotency.execute(operation, async () => {
      announceStart()
      await finish
      return 'fresh'
    })
    const lost = expired.catch((error) => error)
    await Promise.race([started, expired])
    try {
      await delay(375)
      assert.equal(await idempotency.execute(operation, () => 'fresh'), 'fresh')
    } finally {
      finishExecution()
    }
    assert.ok((await lost) instanceof FencingError)
    assert.equal(await idempotency.execute(operation, () => assert.fail('expected a replay')), 'fresh')
    await assert.rejects(
      idempotency.execute({ ...operation, payload: { quantity: 2 } }, () => assert.fail('payload changed')),
      IdempotencyKeyReuseError,
    )

    await assert.rejects(idempotency.execute('failed-order', () => { throw new Error('retry') }), /retry/)
    assert.equal(await idempotency.execute('failed-order', () => 'recovered'), 'recovered')
  })

  await t.test('idempotency skips the callback when acquisition is acknowledged after expiry', async (subtest) => {
    const { createRedisIdempotency, FencingError } = await import('@ainess/ioredis/idempotency')
    const idempotency = createRedisIdempotency(client, { namespace: 'late-acquisition', lockTtl: 100 })
    const sendSet = client.set.bind(client)
    /**
     * @param {string} key
     * @param {string} value
     * @param {'PX'} px
     * @param {number} ttl
     * @param {'NX'} nx
     */
    const delayAcquisition = async (key, value, px, ttl, nx) => {
      const reply = await sendSet(key, value, px, ttl, nx)
      await delay(150)
      assert.equal(await client.pttl(key), -2)
      return reply
    }
    const set = subtest.mock.method(client, 'set', delayAcquisition, { times: 1 })
    let calls = 0
    await assert.rejects(idempotency.execute('order', () => {
      calls++
      return 'receipt'
    }), FencingError)
    assert.equal(set.mock.callCount(), 1)
    assert.equal(calls, 0)
    assert.equal(await idempotency.execute('order', () => 'receipt'), 'receipt')
  })

  await t.test('idempotency releases a live reservation when acquisition took longer than its budget', async (subtest) => {
    const { createRedisIdempotency, FencingError } = await import('@ainess/ioredis/idempotency')
    const idempotency = createRedisIdempotency(client, { namespace: 'slow-dispatch', lockTtl: 300 })
    const sendSet = client.set.bind(client)
    /**
     * @param {string} key
     * @param {string} value
     * @param {'PX'} px
     * @param {number} ttl
     * @param {'NX'} nx
     */
    const delayDispatch = async (key, value, px, ttl, nx) => {
      await delay(ttl + 50)
      const reply = await sendSet(key, value, px, ttl, nx)
      assert.equal(reply, 'OK')
      assert.ok(await client.pttl(key) > 0)
      return reply
    }
    subtest.mock.method(client, 'set', delayDispatch, { times: 1 })
    await assert.rejects(idempotency.execute('order', () => assert.fail('lease budget exhausted')), FencingError)
    assert.equal(await idempotency.get('order'), null)
    assert.equal(await idempotency.execute('order', () => 'receipt'), 'receipt')
  })

  await t.test('idempotency recognizes its own committed result after Redis resends completion', async (subtest) => {
    const { createRedisIdempotency } = await import('@ainess/ioredis/idempotency')
    const idempotency = createRedisIdempotency(client, { namespace: 'resent-completion' })
    let resends = 0
    for (const method of /** @type {const} */ (['eval', 'evalsha'])) {
      const send = client[method].bind(client)
      /**
       * @param {string} script
       * @param {number} keyCount
       * @param {...(string | number | Buffer)} args
       */
      const replayCompletion = async (script, keyCount, ...args) => {
        const response = await send(script, keyCount, ...args)
        if (response !== 1 || args[2] !== 'completed') return response
        resends++
        return send(script, keyCount, ...args)
      }
      subtest.mock.method(client, method, replayCompletion)
    }
    let calls = 0
    const receipt = await idempotency.execute('order', () => {
      calls++
      return 'receipt'
    })
    assert.equal(receipt, 'receipt')
    assert.equal(resends, 1)
    assert.equal(await idempotency.execute('order', () => assert.fail('expected replay')), 'receipt')
    assert.equal(calls, 1)
  })

  await t.test('extra options cannot enable replay of failed idempotent executions', async () => {
    const { createRedisIdempotency } = await import('@ainess/ioredis/idempotency')
    const options = { namespace: 'retryable-orders', persistFailures: true }
    const idempotency = createRedisIdempotency(client, options)
    await assert.rejects(idempotency.execute('order', () => { throw new Error('try again') }), /try again/)
    assert.equal(await idempotency.execute('order', () => 'completed'), 'completed')
  })

  await t.test('invalid idempotency policies and codecs are rejected before execution', async () => {
    const { createRedisIdempotency } = await import('@ainess/ioredis/idempotency')
    assert.throws(
      // @ts-expect-error An untyped caller can pass any string.
      () => createRedisIdempotency(client, { onConflict: 'waitt' }),
      { name: 'TypeError', message: /onConflict/ },
    )
    assert.throws(
      // @ts-expect-error An untyped caller can omit the decoder.
      () => createRedisIdempotency(client, { codec: { encode: JSON.stringify } }),
      { name: 'TypeError', message: /codec/ },
    )
  })

  await t.test('idempotency releases a reservation if the encoded result cannot round-trip through Redis', async () => {
    const { createRedisIdempotency, SerializationError } = await import('@ainess/ioredis/idempotency')
    const idempotency = createRedisIdempotency(client, {
      namespace: 'codec-wire',
      codec: {
        // @ts-expect-error An untyped encoder may return its argument without converting it to a string.
        encode: (value) => value,
        decode: (value) => value,
      },
    })
    for (const invalid of [42, '\uD800']) {
      await assert.rejects(idempotency.execute('order', () => invalid), (error) => {
        assert.ok(error instanceof SerializationError)
        assert.match(error.message, /UTF-8 string/)
        return true
      })
      assert.equal(await idempotency.get('order'), null)
    }
    assert.equal(await idempotency.execute('order', () => '订单 🚀'), '订单 🚀')
    assert.equal(await idempotency.execute('order', () => assert.fail('expected replay')), '订单 🚀')
  })
}

/**
 * @param {import('node:test').TestContext} t
 * @param {import('ioredis').Redis | import('ioredis').Cluster} client
 */
export async function testRedisStringNumbers(t, client) {
  assert.equal(await client.eval('return 1', 1, 'string-numbers'), '1')

  await t.test('manual renewal and release accept string integer replies', async () => {
    const { createRedisLock } = await import('@ainess/ioredis/lock')
    const lease = await createRedisLock(client, 'string-numbers:manual', { ttlMs: 5_000, fencing: true }).tryAcquire()
    assert.ok(lease)
    assert.equal(lease.fencingToken, '1')
    assert.deepEqual([await lease.renew(), await lease.release()], [true, true])
    assert.equal(await lease.release(), false)
  })

  await t.test('automatic renewal accepts string integers in the script result', async () => {
    const { createRedisLock } = await import('@ainess/ioredis/lock')
    const lock = createRedisLock(client, 'string-numbers:auto', { ttlMs: 1_000 })
    const value = await lock.withLock(async ({ signal }) => {
      await delay(1_100)
      assert.equal(signal.aborted, false)
      assert.equal(await lock.tryAcquire(), undefined)
      return 'held'
    })
    assert.equal(value, 'held')
  })

  await t.test('all limiters keep numeric results with string integer replies', async () => {
    const { createRedisRateLimiter } = await import('@ainess/ioredis/rate-limit')
    const configs = /** @type {const} */ ([
      { algorithm: 'fixed-window', windowMs: 3_600_000 },
      { algorithm: 'sliding-window', windowMs: 3_600_000 },
      { algorithm: 'token-bucket', refill: { amount: 1, intervalMs: 3_600_000 } },
    ])
    for (const config of configs) {
      const rateLimit = createRedisRateLimiter(client, { name: 'string-numbers', limit: 1, ...config })
      const first = await rateLimit.consume('tenant')
      assert.equal(first.allowed, true, config.algorithm)
      assert.equal(first.remaining, 0)
      assert.equal(typeof first.resetAt, 'number')
      assert.equal(first.retryAfterMs, 0)
      const second = await rateLimit.consume('tenant', { dryRun: true })
      assert.equal(second.allowed, false)
      assert.ok(second.retryAfterMs > 0)
    }
  })

  await t.test('idempotency extends and completes a lease with string integer replies', async () => {
    const { createRedisIdempotency } = await import('@ainess/ioredis/idempotency')
    const store = createRedisIdempotency(client, { namespace: 'string-numbers' })
    assert.equal(await store.execute('order', async ({ extend }) => {
      await extend()
      return '1'
    }), '1')
    assert.equal(await store.execute('order', () => assert.fail('expected replay')), '1')
    assert.equal(await client.eval('return 1', 1, 'string-numbers'), '1')
  })
}
