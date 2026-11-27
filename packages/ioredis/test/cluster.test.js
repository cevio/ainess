import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { ioredis } from '@ainess/ioredis'
import { Context } from '@deepseek-ai/cordis'
import { Cluster, Redis } from 'ioredis'
import { testRedisPrimitives, testRedisStringNumbers } from './primitives.js'

const hasRedisTools = ['redis-server', 'redis-cli'].every((command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0,
)
const redisCli = promisify(execFile)
const clusterDriver = /** @type {Record<'getInfoFromNode' | 'cluster', Function>} */ (
  /** @type {unknown} */ (Cluster.prototype)
)

/** @param {unknown} _node @param {() => void} callback */
function completeSlotDiscovery(_node, callback) {
  callback()
}

/** @param {number} port */
async function reserve(port) {
  const server = createServer().listen(port, '127.0.0.1')
  await once(server, 'listening')
  return server
}

async function clusterPorts() {
  const ports = []
  const reservations = []
  const first = 20_000 + process.pid % 20_000
  try {
    for (let port = first; port < first + 100 && ports.length < 3; port += 1) {
      try {
        reservations.push(await reserve(port))
        reservations.push(await reserve(port + 10_000))
        ports.push(port)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) throw error
      }
    }
    assert.equal(ports.length, 3, 'could not reserve three Redis and cluster bus port pairs')
    return ports
  } finally {
    await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))))
  }
}

/** @param {number[]} ports */
async function waitForCluster(ports) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const states = await Promise.all(ports.map((port) =>
      redisCli('redis-cli', ['-h', '127.0.0.1', '-p', String(port), 'CLUSTER', 'INFO'], { timeout: 1_000 }),
    ))
    if (states.every(({ stdout }) => /^cluster_state:ok\r?$/m.test(stdout))) return
    await delay(50)
  }
  assert.fail('Redis Cluster did not report a healthy state on every node')
}

test('the cluster provider routes across masters and closes after consumer cleanup', {
  skip: !hasRedisTools && 'redis-server or redis-cli is unavailable',
  timeout: 20_000,
}, async (t) => {
  const ports = await clusterPorts()
  const directory = await mkdtemp(join(tmpdir(), 'ainess-cluster-'))
  const app = new Context()
  /** @type {{ process: import('node:child_process').ChildProcess, stopped: Promise<unknown> }[]} */
  const servers = []
  t.after(async () => {
    try {
      await app.fiber.dispose()
    } finally {
      for (const server of servers) server.process.kill()
      await Promise.all(servers.map((server) => server.stopped))
      await rm(directory, { recursive: true, force: true })
    }
  })

  await Promise.all(ports.map(async (port) => {
    const process = spawn('redis-server', [
      '--bind', '127.0.0.1', '--port', String(port), '--cluster-enabled', 'yes',
      '--cluster-config-file', `nodes-${port}.conf`, '--save', '', '--appendonly', 'no',
    ], { cwd: directory, stdio: ['ignore', 'pipe', 'inherit'] })
    servers.push({ process, stopped: new Promise((resolve) => process.once('close', resolve)) })
    await once(process, 'spawn')
    for await (const line of createInterface({ input: process.stdout })) {
      if (/ready to accept connections/i.test(line)) return
    }
    assert.fail('redis-server exited before it was ready')
  }))
  await redisCli('redis-cli', [
    '--cluster', 'create', ...ports.map((port) => `127.0.0.1:${port}`),
    '--cluster-replicas', '0', '--cluster-yes',
  ], { timeout: 15_000 })
  await waitForCluster(ports)

  const keys = Array.from({ length: 12 }, (_, index) => `{ainess-cluster-${index}}`)
  let used = false
  /** @type {string | null} */
  let cleanupValue = null
  const consumer = app.plugin({
    inject: ['ioredis'],
    async apply(ctx) {
      assert.equal(ctx.ioredis.status, 'ready')
      for (const key of keys) {
        assert.equal(await ctx.ioredis.set(key, key), 'OK')
        assert.equal(await ctx.ioredis.get(key), key)
      }
      used = true
      ctx.effect(() => async () => {
        cleanupValue = await ctx.ioredis.get(keys[0])
      })
    },
  })
  await consumer.await()
  assert.equal(used, false)

  const provider = await app.plugin(ioredis, {
    startupNodes: [{ host: '127.0.0.1', port: ports[0] }],
    clusterOptions: { keyPrefix: 'fixture:', scaleReads: 'all', redisOptions: { commandTimeout: 1_000 } },
  }).await()
  await consumer.await()
  const client = app.get('ioredis')
  assert.ok(client instanceof Cluster)
  assert.equal(used, true)
  const masters = client.nodes('master')
  assert.equal(masters.length, 3)
  const sizes = await Promise.all(masters.map((node) => node.dbsize()))
  assert.ok(sizes.filter((size) => size > 0).length >= 2)

  await testRedisPrimitives(t, client)
  await t.test('native stringNumbers on cluster node connections', async (subtest) => {
    const numbers = client.duplicate(undefined, {
      lazyConnect: true, redisOptions: { ...client.options.redisOptions, stringNumbers: true },
    })
    subtest.after(() => numbers.disconnect())
    await numbers.connect()
    await testRedisStringNumbers(subtest, numbers)
  })
  await t.test('idempotency reads the primary even if a queued read would be routed again', async (subtest) => {
    const { createRedisIdempotency } = await import('@ainess/ioredis/idempotency')
    const originalScaleReads = client.options.scaleReads
    try {
      client.options.scaleReads = 'master'
      const idempotency = createRedisIdempotency(client)
      await idempotency.execute('switch-read-routing', () => 'receipt')

      let routedReads = 0
      const selectReadNode = (/** @type {Redis[]} */ nodes) => {
        routedReads++
        return nodes[0]
      }
      client.options.scaleReads = selectReadNode
      assert.equal(await client.get(keys[0]), keys[0])
      assert.equal(routedReads, 1)
      assert.equal(await idempotency.execute('switch-read-routing', () => assert.fail('expected replay')), 'receipt')
      assert.equal(routedReads, 1)

      client.options.scaleReads = 'master'
      const dispatchGet = client.get.bind(client)
      subtest.mock.method(client, 'get', (/** @type {string} */ key) => {
        // ioredis re-enters sendCommand and reads the current routing option when flushing queued commands.
        client.options.scaleReads = selectReadNode
        return dispatchGet(key)
      })
      assert.equal(await idempotency.execute('switch-read-routing', () => assert.fail('expected replay')), 'receipt')
      assert.equal(routedReads, 1)
    } finally {
      client.options.scaleReads = originalScaleReads
    }
  })
  const storedKeys = (await Promise.all(masters.map((node) => node.keys('*')))).flat()
  for (const feature of ['lock', 'rate-limit', 'idempotency']) {
    const keys = storedKeys.filter((key) => key.includes(`${feature}:`))
    assert.ok(keys.length > 0)
    assert.ok(keys.every((key) => key.startsWith(`fixture:${feature}:`)), keys.join(', '))
  }

  const sockets = masters.map((node) => node.stream).filter(Boolean)
  await provider.dispose()
  assert.equal(cleanupValue, keys[0])
  assert.ok(sockets.every((socket) => socket.destroyed))
  assert.equal(app.get('ioredis', false), undefined)
})

test('cluster configuration errors fail before creating a connection', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const connectRedis = t.mock.method(Redis.prototype, 'connect', async () => {})
  const connectCluster = t.mock.method(Cluster.prototype, 'connect', async () => {})

  // @ts-expect-error Cluster options require startup nodes.
  const incomplete = app.plugin(ioredis, { clusterOptions: {} })
  await assert.rejects(incomplete.await(), /startupNodes is required/)

  const missingSeeds = app.plugin(ioredis, { startupNodes: undefined })
  await assert.rejects(missingSeeds.await(), /startupNodes is required/)

  const mixedOptions = { startupNodes: [{ host: '127.0.0.1', port: 1 }], password: 'fixture', tls: {} }
  // @ts-expect-error Redis node options must be nested under clusterOptions.redisOptions.
  const mixed = app.plugin(ioredis, mixedOptions)
  await assert.rejects(mixed.await(), /Use clusterOptions/)
  assert.equal(connectRedis.mock.callCount(), 0)
  assert.equal(connectCluster.mock.callCount(), 0)
  assert.equal(app.get('ioredis', false), undefined)
})

test('a failed initial cluster connection reports the error without scheduling cluster retries', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  let retries = 0

  const provider = app.plugin(ioredis, {
    startupNodes: [],
    clusterOptions: { clusterRetryStrategy() { retries += 1 } },
  })
  await assert.rejects(provider.await(), /startupNodes.*at least one node/)
  assert.equal(retries, 0)
  assert.equal(app.get('ioredis', false), undefined)
})

test('disposing the cluster provider settles while startup DNS is still pending', {
  timeout: 2_000,
}, async (t) => {
  const app = new Context()
  const server = await reserve(0)
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  let opened = 0
  server.on('connection', (socket) => {
    opened += 1
    socket.destroy()
  })
  /** @type {() => void} */
  let announceLookup
  const lookupStarted = new Promise((resolve) => { announceLookup = () => resolve(undefined) })
  /** @type {(() => void) | undefined} */
  let finishLookup
  t.after(async () => {
    finishLookup?.()
    try {
      await app.fiber.dispose()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  const provider = app.plugin(ioredis, {
    startupNodes: [{ host: 'startup.invalid', port: address.port }],
    clusterOptions: {
      dnsLookup(_hostname, callback) {
        finishLookup = () => callback(null, '127.0.0.1')
        announceLookup()
      },
    },
  })
  await lookupStarted
  const client = app.get('ioredis', false)
  assert.ok(client instanceof Cluster)
  assert.equal(app.get('ioredis'), undefined)
  await provider.dispose()
  assert.equal(app.get('ioredis', false), undefined)

  finishLookup?.()
  finishLookup = undefined
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(client.nodes(), [])
  assert.equal(opened, 0)
})

for (const interruption of ['disposal', 'startup failure']) {
  test(`a late cluster readiness check cannot revive a client after ${interruption}`, {
    timeout: 2_000,
  }, async (t) => {
    const app = new Context()
    t.after(() => app.fiber.dispose())
    const checks = new EventEmitter()
    t.mock.method(clusterDriver, 'getInfoFromNode', completeSlotDiscovery)
    t.mock.method(clusterDriver, 'cluster', (
      /** @type {string} */ command,
      /** @type {(error: null, info: string) => void} */ callback,
    ) => {
      assert.equal(command, 'INFO')
      checks.emit('pending', () => callback(null, 'cluster_state:ok\r\n'))
    })

    const pending = once(checks, 'pending')
    const provider = app.plugin(ioredis, {
      startupNodes: [{ host: '127.0.0.1', port: 1 }],
      clusterOptions: { slotsRefreshInterval: 5_000 },
    })
    const [finishCheck] = await pending
    const client = app.get('ioredis', false)
    assert.ok(client instanceof Cluster)
    t.after(() => client.disconnect())

    if (interruption === 'startup failure') {
      for (const node of client.nodes()) node.disconnect()
      await assert.rejects(provider.await(), /disconnected before becoming ready/)
    } else {
      await provider.dispose()
    }
    await nextTurn()
    finishCheck()
    await nextTurn()

    assert.notEqual(client.status, 'ready')
    assert.equal(app.get('ioredis', false), undefined)
  })
}

test('a topology refresh in flight cannot reschedule itself after disposal', { timeout: 2_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const queries = new EventEmitter()
  const refresh = t.mock.method(Cluster.prototype, 'refreshSlotsCache')
  let queried = false
  t.mock.method(clusterDriver, 'getInfoFromNode', (
    /** @type {unknown} */ _node,
    /** @type {() => void} */ callback,
  ) => {
    if (queried) {
      queries.emit('pending', callback)
    } else {
      queried = true
      callback()
    }
  })

  const pending = once(queries, 'pending')
  const provider = await app.plugin(ioredis, {
    startupNodes: [{ host: '127.0.0.1', port: 1 }],
    clusterOptions: { enableReadyCheck: false, slotsRefreshInterval: 10 },
  }).await()
  const client = app.get('ioredis')
  assert.ok(client instanceof Cluster)
  t.after(() => client.disconnect())

  const [finishRefresh] = await pending
  await provider.dispose()
  const completed = refresh.mock.callCount()
  finishRefresh()
  await delay(30)

  assert.equal(refresh.mock.callCount(), completed)
})

test('disposal stops scheduled topology refresh after all cluster nodes disconnect', { timeout: 2_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  t.mock.method(clusterDriver, 'getInfoFromNode', completeSlotDiscovery)
  const refresh = t.mock.method(Cluster.prototype, 'refreshSlotsCache')

  const provider = await app.plugin(ioredis, {
    startupNodes: [{ host: '127.0.0.1', port: 1 }],
    clusterOptions: { clusterRetryStrategy: null, enableReadyCheck: false, slotsRefreshInterval: 10 },
  }).await()
  const client = app.get('ioredis')
  assert.ok(client instanceof Cluster)
  t.after(() => client.disconnect())

  const ended = once(client, 'end')
  for (const node of client.nodes()) node.disconnect()
  await ended
  await provider.dispose()
  const completed = refresh.mock.callCount()
  await delay(30)

  assert.equal(refresh.mock.callCount(), completed)
})
