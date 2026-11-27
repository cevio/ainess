import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { ioredis } from '@ainess/ioredis'
import { Context } from '@deepseek-ai/cordis'
import { Redis } from 'ioredis'
import { testRedisPrimitives, testRedisStringNumbers } from './primitives.js'

const hasRedisServer = process.platform !== 'win32'
  && spawnSync('redis-server', ['--version'], { stdio: 'ignore' }).status === 0

test('a short lease uses a positive minimum TTL for automatic renewal', async (t) => {
  const { createRedisLock } = await import('@ainess/ioredis/lock')
  const client = new Redis({ lazyConnect: true })
  t.after(() => client.disconnect())
  t.mock.method(performance, 'now', () => 1_000)
  t.mock.method(client, 'eval', async () => 'OK')
  let announceRenewal = () => {}
  const renewal = new Promise((resolve) => { announceRenewal = () => resolve(undefined) })
  let minimumTtl
  /**
   * @param {string} _digest
   * @param {number} _keyCount
   * @param {...(string | number | Buffer)} args
   */
  const scriptReply = async (_digest, _keyCount, ...args) => {
    if (args.length === 4) {
      minimumTtl = args[2]
      announceRenewal()
      return [1, 5]
    }
    assert.equal(args.length, 2)
    return 1
  }
  t.mock.method(client, 'evalsha', scriptReply)

  const lock = createRedisLock(client, 'short-lease', { ttlMs: 9 })
  const result = await lock.withLock(async ({ signal }) => {
    await Promise.race([renewal, once(signal, 'abort', { signal: AbortSignal.timeout(250) })])
    assert.equal(signal.aborted, false)
    return 'held'
  })
  assert.equal(result, 'held')
  assert.equal(minimumTtl, '1')
})

test('Redis is ready before injection, can reconnect, and closes after consumer cleanup', {
  skip: !hasRedisServer && 'redis-server with Unix socket support is unavailable',
  timeout: 10_000,
}, async (t) => {
  const app = new Context()
  const directory = await mkdtemp(join(tmpdir(), 'ainess-redis-'))
  const socket = join(directory, 'redis.sock')
  const server = spawn('redis-server', [
    '--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no',
  ], { cwd: directory, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise((resolve) => server.once('close', resolve))

  t.after(async () => {
    try {
      await app.fiber.dispose()
    } finally {
      server.kill()
      await exited
      await rm(directory, { recursive: true, force: true })
    }
  })

  await once(server, 'spawn')
  let serverReady = false
  for await (const line of createInterface({ input: server.stdout })) {
    if (/ready to accept connections/i.test(line)) {
      serverReady = true
      break
    }
  }
  assert.ok(serverReady, 'redis-server exited before it was ready')

  /** @type {string | null} */
  let valueAtStartup = null
  /** @type {string | null} */
  let valueAtDisposal = null
  const consumer = app.plugin({
    inject: ['ioredis'],
    async apply(ctx) {
      assert.equal(ctx.ioredis.status, 'ready')
      await ctx.ioredis.set('message', 'through Cordis')
      valueAtStartup = await ctx.ioredis.get('message')
      ctx.effect(() => async () => {
        valueAtDisposal = await ctx.ioredis.get('message')
      })
    },
  })
  await consumer.await()
  assert.equal(valueAtStartup, null)

  let retries = 0
  const provider = await app.plugin(ioredis, {
    path: socket,
    commandTimeout: 1_000,
    retryStrategy() {
      retries += 1
      return retries === 1 ? 0 : null
    },
  }).await()
  await consumer.await()
  const client = app.get('ioredis')
  assert.ok(client instanceof Redis)
  assert.equal(valueAtStartup, 'through Cordis')

  const reconnected = once(client, 'ready')
  client.stream.destroy()
  await reconnected
  assert.equal(retries, 1)
  assert.equal(await client.get('message'), 'through Cordis')

  await testRedisPrimitives(t, client)
  await t.test('native stringNumbers on a standalone client', async (subtest) => {
    const numbers = client.duplicate({ lazyConnect: true, stringNumbers: true })
    subtest.after(() => numbers.disconnect())
    await numbers.connect()
    await testRedisStringNumbers(subtest, numbers)
  })

  await provider.dispose()
  assert.equal(valueAtDisposal, 'through Cordis')
  assert.equal(client.status, 'end')
  assert.equal(app.get('ioredis', false), undefined)
})

/** @param {import('node:test').TestContext} t */
async function listen(t) {
  const server = createServer()
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    if (server.listening) {
      server.close()
      await once(server, 'close')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { server, port: address.port }
}

test('a failed initial connection never schedules a retry or publishes the service', async (t) => {
  const { server, port } = await listen(t)
  const app = new Context()
  t.after(() => app.fiber.dispose())

  let retries = 0
  const accepted = once(server, 'connection')
  const provider = app.plugin(ioredis, {
    host: '127.0.0.1',
    port,
    retryStrategy() {
      retries += 1
      return retries === 1 ? 100 : null
    },
    disconnectTimeout: 50,
  })

  const [socket] = await accepted
  await once(socket, 'data')
  socket.end()
  await assert.rejects(provider.await(), { message: 'Connection is closed.' })
  assert.equal(retries, 0)
  assert.equal(app.get('ioredis', false), undefined)
})

test('disposing during the Redis handshake closes the socket without waiting for a reply', {
  timeout: 2_000,
}, async (t) => {
  const { server, port } = await listen(t)
  const app = new Context()
  t.after(() => app.fiber.dispose())

  const accepted = once(server, 'connection')
  const provider = app.plugin(ioredis, { host: '127.0.0.1', port, retryStrategy: null })
  const [socket] = await accepted
  await once(socket, 'data')
  const closed = once(socket, 'close')

  assert.equal(app.get('ioredis'), undefined)
  await provider.dispose()
  await closed
  assert.equal(app.get('ioredis', false), undefined)
})

test('disposing immediately after mounting does not report a startup failure', async (t) => {
  const { port } = await listen(t)
  const app = new Context()
  t.after(() => app.fiber.dispose())

  let errors = 0
  app.logger.exporter({
    export(message) {
      if (message.type === 'error') errors += 1
    },
  })

  const provider = app.plugin(ioredis, { host: '127.0.0.1', port })
  await Promise.resolve()
  await provider.dispose()
  await provider.await()
  assert.equal(errors, 0)
  assert.equal(app.get('ioredis', false), undefined)
})
