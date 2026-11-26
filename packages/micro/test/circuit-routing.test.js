import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import test from 'node:test'
import { createMicroClient } from '@ainess/micro'
import { RegistryClient } from '@ainess/registry-client'
import { RegistryServer } from '@ainess/registry-server'
import { RpcError, RpcMode, RpcServer } from '@ainess/rpc'
import { errorFrame } from '../../rpc/dist/messages.js'
import { encodeHeader, encodeHello, FrameDecoder, FrameType } from '../../rpc/dist/wire.js'

const circuitBreaker = { minimumCalls: 2, openMs: 25, minTimeoutSampleMs: 5 }
const host = '127.0.0.1'

function latch() {
  let release = () => {}
  const promise = new Promise(resolve => { release = () => resolve(undefined) })
  return { promise, release }
}

/** @param {AbortSignal} signal */
function aborted(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
}

/** @param {Uint8Array} bytes */
const decode = bytes => Buffer.from(bytes).toString()

test('opens per service and probes a recovered address once while concurrent calls use the backup', {
  timeout: 5_000,
}, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const oldStarted = latch()
  const oldFinish = latch()
  const probeStarted = latch()
  const probeFinish = latch()
  t.after(oldFinish.release)
  t.after(probeFinish.release)
  let primaryCalls = 0
  let backupCalls = 0
  let accepted = 0
  const primary = await RpcServer.listen({
    host, port: 0,
    onPeer: () => { accepted++ },
    methods: [
      {
        name: 'sync',
        mode: RpcMode.Unary,
        async handle({ data }) {
          primaryCalls++
          const action = decode(data)
          if (action === 'fail') throw new RpcError('UNAVAILABLE', 'primary is busy')
          if (action === 'old') {
            oldStarted.release()
            await oldFinish.promise
          }
          if (action === 'probe') {
            probeStarted.release()
            await probeFinish.promise
          }
          return Buffer.from('primary')
        },
      },
      { name: 'inventory', mode: RpcMode.Unary, handle: () => Buffer.from('same connection') },
    ],
  })
  t.after(() => primary.close())
  const backup = await RpcServer.listen({
    host, port: 0,
    methods: [{
      name: 'sync', mode: RpcMode.Unary, handle() {
        backupCalls++
        return Buffer.from('backup')
      },
    }],
  })
  t.after(() => backup.close())
  const registry = await RegistryServer.listen({ host, port: 0 })
  t.after(() => registry.close())
  const registryClient = await RegistryClient.connect(registry.address)
  t.after(() => registryClient.close())
  await registryClient.discovery.register({ ...primary.address, services: ['orders', 'inventory'] })

  /** @type {(readonly import('@ainess/rpc').RpcAddress[])[]} */
  const lookups = []
  const client = createMicroClient({
    circuitBreaker,
    discovery: {
      pick(query, options) {
        if (query.service === 'orders') lookups.push(query.exclude ?? [])
        return registryClient.discovery.pick(query, options)
      },
    },
  })
  t.after(() => client.close())
  const old = client.request('orders', 'sync', Buffer.from('old')).then(decode)
  void old.catch(() => {})
  await oldStarted.promise
  await assert.rejects(client.request('orders', 'sync', Buffer.from('fail')), { code: 'UNAVAILABLE' })
  await registryClient.discovery.register({ ...backup.address, services: ['orders'] })
  /** @type {Promise<string> | undefined} */
  let reentrant
  const observeFailure = Object.freeze({
    onFailure() {
      reentrant = client.request('orders', 'sync').then(decode)
      void reentrant.catch(() => {})
    },
  })
  await assert.rejects(client.request('orders', 'sync', Buffer.from('fail'), observeFailure), { code: 'UNAVAILABLE' })
  assert.equal(await reentrant, 'backup', 'the breaker opens before notifying the caller')
  assert.equal(backupCalls, 1, 'only the new call is sent to the backup')
  assert.equal(decode(await client.request('inventory', 'inventory')), 'same connection')
  assert.equal(accepted, 1)
  oldFinish.release()
  assert.equal(await old, 'primary')

  const concurrent = () => Promise.all(Array.from({ length: 16 }, () => client.request('orders', 'sync').then(decode)))
  assert.deepEqual(await concurrent(), Array(16).fill('backup'))
  assert.deepEqual(lookups, [[], [primary.address]])
  now += circuitBreaker.openMs
  await assert.rejects(client.request('orders', 'sync', Buffer.from('fail')), { code: 'UNAVAILABLE' })
  assert.equal(decode(await client.request('orders', 'sync')), 'backup')
  now += circuitBreaker.openMs
  const probe = client.request('orders', 'sync', Buffer.from('probe')).then(decode)
  void probe.catch(() => {})
  await probeStarted.promise
  assert.deepEqual(await concurrent(), Array(16).fill('backup'))
  probeFinish.release()
  assert.equal(await probe, 'primary')
  assert.equal(decode(await client.request('orders', 'sync')), 'primary')
  assert.equal(primaryCalls, 6)
  assert.equal(accepted, 1)
})

test('only dispatched unary timeouts with enough response time count as business failures', {
  timeout: 5_000,
}, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  let sent = latch()
  const primary = await RpcServer.listen({
    host, port: 0,
    methods: [
      { name: 'echo', mode: RpcMode.Unary, handle: () => Buffer.from('primary') },
      {
        name: 'slow', mode: RpcMode.Unary, async handle({ signal }) {
          sent.release()
          await aborted(signal)
          return Buffer.alloc(0)
        },
      },
      {
        name: 'upload', mode: RpcMode.ClientStream, async handle({ input }) {
          for await (const _ of input) { /* consume upload */ }
          return Buffer.alloc(0)
        },
      },
    ],
  })
  t.after(() => primary.close())
  const backup = await RpcServer.listen({
    host, port: 0,
    methods: [{ name: 'echo', mode: RpcMode.Unary, handle: () => Buffer.from('backup') }],
  })
  t.after(() => backup.close())
  const client = createMicroClient({
    circuitBreaker: { ...circuitBreaker, minimumCalls: 3 },
    discovery: {
      async pick({ exclude }) {
        return exclude?.some(({ port }) => port === primary.address.port) ? backup.address : primary.address
      },
    },
  })
  t.after(() => client.close())

  for (let i = 0; i < 2; i++) {
    await assert.rejects(client.request('orders', 'upload', undefined, {
      async *input() {
        throw new RpcError('UNAVAILABLE', 'local upload producer failed')
      },
    }), { code: 'UNAVAILABLE' })
  }
  assert.equal(decode(await client.request('orders', 'echo')), 'primary')
  for (const elapsed of [0, 0, 5, 5]) {
    sent = latch()
    const rejected = assert.rejects(client.request('orders', 'slow', undefined, { timeoutMs: 50 }), {
      code: 'DEADLINE_EXCEEDED',
    })
    await Promise.race([sent.promise, rejected])
    now += elapsed
    await rejected
  }
  assert.equal(decode(await client.request('orders', 'echo')), 'backup')
})

test('a delayed timer does not turn a short deadline into a circuit failure', { timeout: 5_000 }, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const sent = latch()
  const server = await RpcServer.listen({
    host, port: 0,
    methods: [
      { name: 'echo', mode: RpcMode.Unary, handle: () => Buffer.from('primary') },
      {
        name: 'slow', mode: RpcMode.Unary, async handle({ signal }) {
          sent.release()
          await aborted(signal)
          return Buffer.alloc(0)
        },
      },
    ],
  })
  t.after(() => server.close())
  const client = createMicroClient({
    circuitBreaker: { minimumCalls: 1, minTimeoutSampleMs: 1_000 },
    discovery: { async pick({ exclude }) { return exclude?.length ? null : server.address } },
  })
  t.after(() => client.close())

  await client.request('orders', 'echo')
  const rejected = assert.rejects(client.request('orders', 'slow', undefined, { timeoutMs: 100 }), {
    code: 'DEADLINE_EXCEEDED',
  })
  await Promise.race([sent.promise, rejected])
  now += 2_000
  await rejected
  assert.equal(decode(await client.request('orders', 'echo')), 'primary')
})

test('changing a discovery exclusion cannot change a cached address', { timeout: 5_000 }, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const server = await RpcServer.listen({
    host, port: 0,
    methods: [{ name: 'read', mode: RpcMode.Unary, handle() { throw new RpcError('UNAVAILABLE') } }],
  })
  t.after(() => server.close())
  /** @type {number[]} */
  const ports = []
  const client = createMicroClient({
    circuitBreaker: { minimumCalls: 1 },
    discovery: {
      async pick({ exclude }) {
        const excluded = exclude?.[0]
        if (!excluded) return server.address
        ports.push(excluded.port)
        excluded.port = 1
        return null
      },
    },
  })
  t.after(() => client.close())

  for (let i = 0; i < 3; i++) {
    await assert.rejects(client.request('orders', 'read'), { code: 'UNAVAILABLE' })
    now += 200
  }
  assert.deepEqual(ports, [server.address.port, server.address.port])
})

test('returning a stream before its first response releases the half-open trial', { timeout: 5_000 }, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const waiting = latch()
  const server = await RpcServer.listen({
    host, port: 0,
    methods: [
      {
        name: 'fail',
        mode: RpcMode.Unary,
        handle() { throw new RpcError('DEADLINE_EXCEEDED', 'remote deadline') },
      },
      {
        name: 'wait',
        mode: RpcMode.ServerStream,
        async *handle({ signal }) {
          waiting.release()
          await aborted(signal)
          yield Buffer.alloc(0)
        },
      },
      { name: 'empty', mode: RpcMode.ServerStream, async *handle() {} },
      { name: 'echo', mode: RpcMode.Unary, handle: () => Buffer.from('ready') },
    ],
  })
  t.after(() => server.close())
  const client = createMicroClient({
    circuitBreaker,
    discovery: { async pick({ exclude }) { return exclude?.length ? null : server.address } },
  })
  t.after(() => client.close())
  for (let i = 0; i < 2; i++) {
    await assert.rejects(client.request('orders', 'fail'), { code: 'DEADLINE_EXCEEDED' })
  }
  await assert.rejects(client.request('orders', 'echo'), { code: 'UNAVAILABLE' })
  now += circuitBreaker.openMs
  const stream = client.stream('orders', 'wait')
  const read = assert.rejects(stream.next(), { code: 'CANCELLED' })
  await waiting.promise
  await stream.return?.()
  await read
  assert.equal((await client.stream('orders', 'empty').next()).done, true)
  assert.equal(decode(await client.request('orders', 'echo')), 'ready')
})

test('successful responses earlier in the same TCP read contribute to the failure rate', {
  timeout: 5_000,
}, async t => {
  const successful = 20
  const failing = 10
  /** @param {import('../../rpc/dist/wire.js').Frame} value */
  const encode = value => Buffer.concat([encodeHeader(value), value.body])
  const good = Buffer.from('primary')
  const unavailable = new RpcError('UNAVAILABLE')
  const primary = createServer(socket => {
    t.after(() => { socket.destroy() })
    const decoder = new FrameDecoder()
    /** @type {Buffer[]} */
    let responses = []
    let sentBatch = false
    socket.on('data', chunk => decoder.push(Buffer.from(chunk), frame => {
      if (frame.type === FrameType.Hello) {
        socket.write(encode({ id: 0, type: FrameType.Hello, flags: 0, body: encodeHello() }))
      } else if (frame.type === FrameType.Open) {
        const end = { id: frame.id, type: FrameType.End, flags: 0, body: good }
        if (sentBatch) {
          socket.write(encode(end))
          return
        }
        responses.push(encode(responses.length < successful ? end : errorFrame(frame.id, unavailable)))
        if (responses.length === successful + failing) {
          sentBatch = true
          socket.write(Buffer.concat(responses))
          responses = []
        }
      }
    }))
  })
  primary.listen(0, host)
  await once(primary, 'listening')
  const primaryAddress = primary.address()
  assert.ok(primaryAddress && typeof primaryAddress !== 'string')

  const backup = await RpcServer.listen({
    host, port: 0,
    methods: [{ name: 'echo', mode: RpcMode.Unary, handle: () => Buffer.from('backup') }],
  })
  t.after(() => backup.close())
  const client = createMicroClient({
    discovery: {
      async pick({ exclude }) {
        return exclude?.length ? backup.address : { host, port: primaryAddress.port }
      },
    },
  })
  t.after(async () => {
    await client.close()
    await new Promise(resolve => primary.close(() => resolve(undefined)))
  })
  const results = await Promise.allSettled(Array.from({ length: successful + failing }, () =>
    client.request('orders', 'echo')))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, successful)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'UNAVAILABLE').length, failing)
  assert.equal(decode(await client.request('orders', 'echo')), 'primary')
})

test('transport failure callbacks exclude the lost address before selecting and retain the alternate attempt', {
  timeout: 5_000,
}, async t => {
  const entered = latch()
  const primary = await RpcServer.listen({
    host, port: 0,
    methods: [{
      name: 'hold', mode: RpcMode.Unary, async handle({ signal }) {
        entered.release()
        await aborted(signal)
        return Buffer.alloc(0)
      },
    }],
  })
  t.after(() => primary.close())
  const primaryAddress = primary.address
  const backup = await RpcServer.listen({
    host, port: 0,
    methods: [{ name: 'echo', mode: RpcMode.Unary, handle: () => Buffer.from('healthy') }],
  })
  t.after(() => backup.close())
  const closed = createServer()
  closed.listen(0, host)
  await once(closed, 'listening')
  const closedAddress = closed.address()
  assert.ok(closedAddress && typeof closedAddress === 'object')
  await new Promise(resolve => closed.close(() => resolve(undefined)))
  const dead = { host, port: closedAddress.port }
  const endpoints = [primaryAddress, dead, backup.address]
  /** @type {(readonly import('@ainess/rpc').RpcAddress[])[]} */
  const lookups = []
  const client = createMicroClient({
    discovery: {
      async pick({ exclude = [] }) {
        lookups.push(exclude)
        return endpoints.find(({ port }) => exclude.every(address => address.port !== port)) ?? null
      },
    },
  })
  t.after(() => client.close())
  /** @type {Promise<string> | undefined} */
  let recovery
  const rejected = assert.rejects(client.request('orders', 'hold', undefined, {
    onFailure() {
      recovery = client.request('orders', 'echo').then(decode)
      void recovery.catch(() => {})
    },
  }), { code: 'UNAVAILABLE' })
  await Promise.race([entered.promise, rejected])
  await primary.close()
  await rejected
  assert.equal(await recovery, 'healthy')
  assert.deepEqual(lookups.slice(0, 2), [[], [primaryAddress]])
  assert.equal(lookups.length, 3)
  assert.deepEqual(new Set(lookups[2]), new Set([primaryAddress, dead]))
})

test('circuit breaker accepts only an options object or false', async t => {
  const discovery = { async pick() { return null } }
  for (const value of ['false', true, 0, [], null]) {
    /** @type {import('@ainess/micro').MicroOptions['circuitBreaker']} */
    const circuitBreaker = JSON.parse(JSON.stringify(value))
    assert.throws(() => {
      const client = createMicroClient({ discovery, circuitBreaker })
      t.after(() => client.close())
    }, TypeError)
  }
  const client = createMicroClient({ discovery, circuitBreaker: false })
  t.after(() => client.close())
})

for (const expiry of ['during', 'after']) test(`an expired address can rejoin when its cooldown ends ${expiry} discovery`, {
  timeout: 5_000,
}, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const entered = latch()
  const lookupStarted = latch()
  const finishLookup = latch()
  t.after(finishLookup.release)
  const primary = await RpcServer.listen({
    host, port: 0,
    methods: [{
      name: 'hold',
      mode: RpcMode.Unary,
      async handle({ signal }) {
        entered.release()
        await aborted(signal)
        return Buffer.alloc(0)
      },
    }],
  })
  t.after(() => primary.close())
  const address = primary.address
  /** @type {(readonly import('@ainess/rpc').RpcAddress[])[]} */
  const lookups = []
  const client = createMicroClient({
    discovery: {
      async pick({ exclude = [] }) {
        lookups.push(exclude)
        if (!exclude.length) return address
        lookupStarted.release()
        await finishLookup.promise
        return null
      },
    },
  })
  t.after(() => client.close())
  const lost = assert.rejects(client.request('orders', 'hold'), { code: 'UNAVAILABLE' })
  await Promise.race([entered.promise, lost])
  await primary.close()
  await lost
  if (expiry === 'after') now += 4_950
  const recovery = client.request('orders', 'echo').then(decode)
  void recovery.catch(() => {})
  await Promise.race([lookupStarted.promise, recovery])
  if (expiry === 'after') {
    finishLookup.release()
    await assert.rejects(recovery, { code: 'UNAVAILABLE' })
    // The lookup failure is cached for 200 ms, but the endpoint has 50 ms of cooldown left.
  }
  const recovered = await RpcServer.listen({
    ...address,
    methods: [{ name: 'echo', mode: RpcMode.Unary, handle: () => Buffer.from('ready') }],
  })
  t.after(() => recovered.close())
  now += expiry === 'after' ? 50 : 5_000
  finishLookup.release()
  assert.equal(await (expiry === 'during' ? recovery : client.request('orders', 'echo').then(decode)), 'ready')
  assert.deepEqual(lookups, [[], [address], []])
})
