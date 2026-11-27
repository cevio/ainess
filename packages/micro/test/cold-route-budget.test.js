import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Socket, createConnection, createServer } from 'node:net'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createMicroClient } from '@ainess/micro'
import { RpcError, RpcMode, RpcServer } from '@ainess/rpc'
import { deferred } from '../../rpc/dist/deferred.js'

const host = '127.0.0.1'

/**
 * @param {import('node:test').TestContext} t
 * @param {(socket: import('node:net').Socket) => void} [onConnection]
 */
async function tcpEndpoint(t, onConnection) {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    onConnection?.(socket)
  })
  server.listen(0, host)
  await once(server, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { host, port: address.port }
}

/**
 * @param {import('node:test').TestContext} t
 * @param {readonly import('@ainess/rpc').RpcMethod[]} [methods]
 */
async function startRpcServer(t, methods = [{ name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data }]) {
  const server = await RpcServer.listen({ host, port: 0, methods })
  t.after(() => server.close())
  return server
}

/**
 * @param {import('node:test').TestContext} t
 * @param {import('@ainess/rpc').RpcAddress} target
 */
async function holdServerHello(t, target) {
  const release = deferred()
  const connected = deferred()
  t.after(() => release.resolve(undefined))
  let connections = 0
  const address = await tcpEndpoint(t, downstream => {
    connections++
    const upstream = createConnection(target)
    downstream.on('close', () => upstream.destroy())
    upstream.on('close', () => downstream.destroy())
    upstream.on('error', () => downstream.destroy())
    downstream.pipe(upstream)
    void release.promise.then(() => {
      if (!downstream.destroyed) upstream.pipe(downstream)
    })
    connected.resolve(undefined)
  })
  return {
    address,
    connected: connected.promise,
    resume: () => release.resolve(undefined),
    get connections() { return connections },
  }
}

test('a silent first handshake leaves enough default route budget to reach a healthy backup', {
  timeout: 5_000,
}, async t => {
  const primary = await tcpEndpoint(t)
  const healthy = await startRpcServer(t)

  /** @type {unknown[]} */
  const queries = []
  /** @type {import('@ainess/micro').MicroTimingEvent[]} */
  const timings = []
  const client = createMicroClient({
    timeoutMs: 600,
    onTiming(event) {
      timings.push(event)
      throw new Error('broken timing observer')
    },
    discovery: {
      async pick(query) {
        queries.push(query)
        return query.exclude?.length ? healthy.address : primary
      },
    },
  })
  t.after(() => client.close())

  assert.deepEqual(await client.request('orders', 'echo', Buffer.from('backup')), Buffer.from('backup'))
  assert.deepEqual(queries, [{ service: 'orders' }, { service: 'orders', exclude: [primary] }])
  assert.deepEqual(timings.map(event => [event.phase, event.outcome, event.service,
    event.phase === 'rpc' ? event.method : event.attempt]), [
    ['discovery', 'success', 'orders', 1],
    ['connect', 'failure', 'orders', 1],
    ['discovery', 'success', 'orders', 2],
    ['connect', 'success', 'orders', 2],
    ['rpc', 'success', 'orders', 'echo'],
  ])
  for (const event of timings) {
    assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0)
  }
  assert.ok(timings[1].error)
})

test('a connection finishing after the shared deadline can only serve a later call', async t => {
  let now = 1_000
  let calls = 0
  t.mock.method(performance, 'now', () => now)
  const server = await startRpcServer(t, [{
    name: 'echo',
    mode: RpcMode.Unary,
    handle({ data }) {
      calls++
      return data
    },
  }])
  const client = createMicroClient({
    resolveTimeoutMs: 100,
    discovery: { async pick() { return server.address } },
    onTiming(event) {
      if (event.phase === 'connect' && event.outcome === 'success') now += 101
    },
  })
  t.after(() => client.close())

  await assert.rejects(client.request('orders', 'echo'), { code: 'UNAVAILABLE' })
  assert.equal(calls, 0)
  assert.deepEqual(await client.request('orders', 'echo', Buffer.from('next')), Buffer.from('next'))
  assert.equal(calls, 1)
})

test('discards a discovery result observed after the per-attempt deadline', async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  let executions = 0
  const server = await startRpcServer(t, [{
    name: 'echo',
    mode: RpcMode.Unary,
    handle({ data }) {
      executions++
      return data
    },
  }])
  /** @type {AbortSignal | undefined} */
  let discoverySignal
  /** @type {import('@ainess/micro').MicroTimingEvent[]} */
  const timings = []
  const client = createMicroClient({
    connectTimeoutMs: 50,
    resolveTimeoutMs: 1_000,
    discovery: {
      async pick(_query, options) {
        discoverySignal = options?.signal
        now += 51
        return server.address
      },
    },
    onTiming: event => { timings.push(event) },
  })
  t.after(() => client.close())

  await assert.rejects(client.request('orders', 'echo'), { code: 'UNAVAILABLE' })
  assert.equal(executions, 0)
  assert.equal(discoverySignal?.aborted, true)
  assert.equal(discoverySignal?.reason?.name, 'TimeoutError')
  assert.deepEqual(timings.map(event => [event.phase, event.outcome]), [['discovery', 'failure']])
})

test('reselects when a real TCP handshake is observed after its physical dial deadline', { timeout: 5_000 }, async t => {
  let now = 1_000
  let primaryCalls = 0
  t.mock.method(performance, 'now', () => now)
  const provider = await startRpcServer(t, [{
    name: 'echo',
    mode: RpcMode.Unary,
    handle({ data }) {
      primaryCalls++
      return data
    },
  }])
  const primary = await holdServerHello(t, provider.address)
  const backup = await startRpcServer(t)
  const client = createMicroClient({
    connectTimeoutMs: 250,
    resolveTimeoutMs: 1_500,
    discovery: { async pick({ exclude }) { return exclude?.length ? backup.address : primary.address } },
  })
  t.after(() => client.close())

  const data = Buffer.from('written on backup')
  const request = client.request('orders', 'echo', data)
  void request.catch(() => {})
  await Promise.race([primary.connected, request])
  now += 300
  primary.resume()

  assert.deepEqual(await request, data)
  assert.equal(primary.connections, 1)
  assert.equal(primaryCalls, 0)
})

test('does not submit a request when cold selection has used its call budget', async t => {
  let now = 1_000
  let executions = 0
  t.mock.method(performance, 'now', () => now)
  const server = await startRpcServer(t, [{
    name: 'write',
    mode: RpcMode.Unary,
    handle({ data }) {
      executions++
      return data
    },
  }])
  const client = createMicroClient({
    resolveTimeoutMs: 1_000,
    discovery: { async pick() { return server.address } },
    onTiming(event) {
      if (event.phase === 'connect' && event.outcome === 'success') now += 300
    },
  })
  t.after(() => client.close())

  await assert.rejects(client.request('orders', 'write', undefined, { timeoutMs: 250 }), {
    code: 'DEADLINE_EXCEEDED',
  })
  assert.equal(executions, 0)
})

test('discards queued unary and stream requests that expire before the TCP socket drains', { timeout: 5_000 }, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  /** @type {string[]} */
  const executions = []
  const server = await startRpcServer(t, [{
    name: 'write',
    mode: RpcMode.Unary,
    handle({ data }) {
      executions.push(Buffer.from(data).toString())
      return data
    },
  }, {
    name: 'write-stream',
    mode: RpcMode.ServerStream,
    handle({ data }) {
      executions.push(Buffer.from(data).toString())
      return (async function* () { yield data })()
    },
  }])
  let connections = 0
  /** @type {Socket | undefined} */
  let socket
  const keepAlive = Socket.prototype.setKeepAlive
  /** @this {Socket} @param {boolean} [enable] @param {number} [initialDelay] */
  function captureDialer(enable, initialDelay) {
    if (this.remotePort === server.address.port) {
      socket = this
      connections++
    }
    return keepAlive.call(this, enable, initialDelay)
  }
  t.mock.method(Socket.prototype, 'setKeepAlive', captureDialer)
  const client = createMicroClient({ discovery: { async pick() { return server.address } } })
  t.after(() => client.close())

  await client.request('orders', 'write', Buffer.from('warm'))
  assert.ok(socket)
  const dialer = socket
  const write = dialer.write
  let writes = 0
  t.mock.method(dialer, 'write', (/** @type {Uint8Array} */ bytes) => {
    const written = write.call(dialer, bytes)
    // Hold subsequent modem writes until the test releases backpressure.
    return ++writes === 1 ? false : written
  })

  const primer = client.request('orders', 'write', Buffer.from('primer'))
  const unary = client.request('orders', 'write', Buffer.from('expired unary'), { timeoutMs: 250 })
  const stream = client.stream('orders', 'write-stream', Buffer.from('expired stream'), {
    timeoutMs: false,
    firstResponseTimeoutMs: 250,
  })
  t.after(() => stream.return?.())
  const firstRead = stream.next()
  const next = client.request('orders', 'write', Buffer.from('next'))
  const results = Promise.allSettled([primer, unary, firstRead, next])
  assert.equal(writes, 1)
  now += 300
  dialer.emit('drain')

  const [first, unaryDeadline, streamDeadline, last] = await results
  assert.deepEqual(executions, ['warm', 'primer', 'next'])
  assert.equal(unaryDeadline.status, 'rejected')
  assert.equal(unaryDeadline.reason.code, 'DEADLINE_EXCEEDED')
  assert.equal(streamDeadline.status, 'rejected')
  assert.equal(streamDeadline.reason.code, 'DEADLINE_EXCEEDED')
  assert.deepEqual(streamDeadline.reason.cause, { phase: 'first-response' })
  assert.deepEqual(first, { status: 'fulfilled', value: Buffer.from('primer') })
  assert.deepEqual(last, { status: 'fulfilled', value: Buffer.from('next') })
  assert.equal(connections, 1)
})

test('reports the caller deadline when the shared selection also expires', async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const client = createMicroClient({
    timeoutMs: 250,
    discovery: { async pick() { now += 300; return null } },
  })
  t.after(() => client.close())

  await assert.rejects(client.request('orders', 'echo'), { code: 'DEADLINE_EXCEEDED' })
})

test('reselection uses the remaining shared budget when a short caller has already timed out', {
  timeout: 5_000,
}, async t => {
  const primary = await tcpEndpoint(t)
  const healthy = await startRpcServer(t)
  /** @type {AbortSignal | undefined} */
  let alternateSignal
  /** @type {unknown[]} */
  const queries = []
  const client = createMicroClient({
    timeoutMs: 2_500,
    connectTimeoutMs: 2_000,
    resolveTimeoutMs: 600,
    discovery: {
      async pick(query, { signal } = {}) {
        queries.push(query)
        if (!query.exclude?.length) return primary
        alternateSignal = signal
        return delay(500, healthy.address, { signal })
      },
    },
  })
  t.after(() => client.close())

  await Promise.all([
    assert.rejects(client.request('orders', 'echo', undefined, { timeoutMs: 40 }), { code: 'DEADLINE_EXCEEDED' }),
    assert.rejects(client.request('orders', 'echo'), { code: 'UNAVAILABLE' }),
  ])
  assert.deepEqual(queries, [{ service: 'orders' }, { service: 'orders', exclude: [primary] }])
  assert.ok(alternateSignal?.aborted)
})

test('a fallback can use the original in-progress dial when discovery has no other candidate', {
  timeout: 5_000,
}, async t => {
  const server = await startRpcServer(t)
  const relay = await holdServerHello(t, server.address)
  /** @type {unknown[]} */
  const queries = []
  /** @type {('success' | 'failure')[]} */
  const discoveryOutcomes = []
  const client = createMicroClient({
    timeoutMs: 1_500,
    resolveTimeoutMs: 600,
    onTiming(event) {
      if (event.phase === 'discovery') discoveryOutcomes.push(event.outcome)
    },
    discovery: {
      async pick(query) {
        queries.push(query)
        if (!query.exclude?.length) return relay.address
        relay.resume()
        return null
      },
    },
  })
  t.after(() => client.close())

  assert.deepEqual(await client.request('orders', 'echo', Buffer.from('original')), Buffer.from('original'))
  assert.deepEqual(queries, [{ service: 'orders' }, { service: 'orders', exclude: [relay.address] }])
  assert.deepEqual(discoveryOutcomes, ['success', 'success'])
  assert.equal(relay.connections, 1)
})

test('the original dial can finish while speculative discovery is still pending', {
  timeout: 5_000,
}, async t => {
  const server = await startRpcServer(t)
  const relay = await holdServerHello(t, server.address)
  /** @type {AbortSignal | undefined} */
  let alternateSignal
  const client = createMicroClient({
    timeoutMs: 1_200,
    resolveTimeoutMs: 1_600,
    discovery: {
      async pick(query, { signal } = {}) {
        if (!query.exclude?.length) return relay.address
        alternateSignal = signal
        relay.resume()
        return delay(5_000, null, { signal })
      },
    },
  })
  t.after(() => client.close())

  assert.deepEqual(await client.request('orders', 'echo', Buffer.from('original')), Buffer.from('original'))
  assert.ok(alternateSignal?.aborted)
  assert.equal(relay.connections, 1)
})

test('a second service can join the physical dial after the first service switches addresses', {
  timeout: 5_000,
}, async t => {
  const server = await startRpcServer(t, [
    { name: 'origin', mode: RpcMode.Unary, handle: () => Buffer.from('primary') },
  ])
  const backup = await startRpcServer(t, [
    { name: 'origin', mode: RpcMode.Unary, handle: () => Buffer.from('backup') },
  ])
  const relay = await holdServerHello(t, server.address)
  const client = createMicroClient({
    timeoutMs: 1_500,
    connectTimeoutMs: 1_200,
    resolveTimeoutMs: 600,
    discovery: {
      async pick(query) {
        if (query.service === 'inventory') {
          relay.resume()
          return relay.address
        }
        return query.exclude?.length ? backup.address : relay.address
      },
    },
  })
  t.after(() => client.close())

  assert.deepEqual(await client.request('orders', 'origin'), Buffer.from('backup'))
  assert.deepEqual(await client.request('inventory', 'origin'), Buffer.from('primary'))
  assert.equal(relay.connections, 1)
})

test('a stream records its first response once and preserves a later remote error', {
  timeout: 5_000,
}, async t => {
  const server = await startRpcServer(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle() {
      yield Buffer.from('event')
      throw new RpcError('UNAVAILABLE', 'broken stream')
    },
  }])
  /** @type {import('@ainess/micro').MicroTimingEvent[]} */
  const timings = []
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
    onTiming(event) { timings.push(event) },
  })
  t.after(() => client.close())

  const stream = client.stream('orders', 'events')
  assert.equal(timings.length, 0)
  assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('event') })
  await assert.rejects(stream.next(), { code: 'UNAVAILABLE', message: 'broken stream' })
  assert.deepEqual(timings.map(({ phase, outcome }) => [phase, outcome]), [
    ['discovery', 'success'],
    ['connect', 'success'],
    ['rpc', 'success'],
  ])
})
