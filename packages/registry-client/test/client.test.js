import assert from 'node:assert/strict'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import net, { createServer } from 'node:net'
import { test } from 'node:test'
import { setImmediate as yieldToIo, setTimeout as delay } from 'node:timers/promises'
import { RegistryClient, registry } from '@ainess/registry-client'
import { RpcError, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'
import { Context } from '@deepseek-ai/cordis'
import { deferred } from '../../rpc/dist/deferred.js'
import { MessageModem } from '../../rpc/dist/modem.js'
import { MAX_CALL_ID } from '../../rpc/dist/wire.js'

/** @typedef {import('@ainess/rpc').RpcAddress} Address */
/** @typedef {import('@ainess/rpc').RpcPeer} Peer */
/** @typedef {import('@ainess/rpc').RpcMethod} Method */
/** @typedef {Address & { services: string[] }} Registration */
/** @typedef {{ peer: Peer, address: Address, service: string }} Claim */

const address = { host: 'node.example', port: 8080 }
const otherAddress = { host: 'other.example', port: 9000 }
const orders = { ...address, services: ['orders'] }
const refunds = { ...address, services: ['refunds'] }

/** @param {unknown} value */
const encode = (value) => new TextEncoder().encode(JSON.stringify(value))
/** @param {Uint8Array} data */
const decode = (data) => JSON.parse(new TextDecoder().decode(data))

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition did not become true')
    await delay(10)
  }
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{
 *   register?: (request: Registration, signal: AbortSignal) => void | Promise<void>,
 *   list?: (service: string) => AsyncIterable<Address[]>,
 *   pick?: (query: import('@ainess/registry-client').PickQuery, signal: AbortSignal) => void | Promise<void>
 * }} [hooks]
 */
async function startRegistry(t, hooks = {}) {
  /** @type {Set<Peer>} */
  const peers = new Set()
  /** @type {Claim[]} */
  const claims = []
  /** @type {Registration[]} */
  const registrations = []
  let connections = 0
  /** @param {string} service */
  const addresses = (service) => claims.filter((claim) => claim.service === service).map((claim) => claim.address)
  /** @param {Peer} peer @param {Registration} request @param {string} service */
  const index = (peer, request, service) => claims.findIndex((claim) => claim.peer === peer &&
    claim.service === service && claim.address.host === request.host && claim.address.port === request.port)
  /** @type {Method[]} */
  const methods = [
    {
      name: 'registry.discovery.register',
      mode: RpcMode.Unary,
      async handle({ data, peer, signal }) {
        const request = /** @type {Registration} */ (decode(data))
        registrations.push(request)
        const services = [...new Set(request.services)]
        for (const service of services) {
          if (index(peer, request, service) < 0) {
            claims.push({ peer, service, address: { host: request.host, port: request.port } })
          }
        }
        await hooks.register?.(request, signal)
        return encode({ registered: services })
      },
    },
    {
      name: 'registry.discovery.unregister',
      mode: RpcMode.Unary,
      handle({ data, peer }) {
        const request = /** @type {Registration} */ (decode(data))
        const removed = request.services.filter((service) => {
          const position = index(peer, request, service)
          if (position < 0) return false
          claims.splice(position, 1)
          return true
        })
        return encode({ removed })
      },
    },
    {
      name: 'registry.discovery.list',
      mode: RpcMode.ServerStream,
      async *handle({ data }) {
        const { service } = decode(data)
        if (hooks.list) {
          for await (const batch of hooks.list(service)) yield encode(batch)
          return
        }
        for (const endpoint of addresses(service)) yield encode([endpoint])
      },
    },
    {
      name: 'registry.discovery.pick',
      mode: RpcMode.Unary,
      async handle({ data, signal }) {
        const query = /** @type {import('@ainess/registry-client').PickQuery} */ (decode(data))
        await hooks.pick?.(query, signal)
        return encode(addresses(query.service)[0] ?? null)
      },
    },
  ]
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods,
    onPeer(peer) {
      peers.add(peer)
      connections++
      peer.onClose(() => {
        peers.delete(peer)
        for (let i = claims.length - 1; i >= 0; i--) {
          if (claims[i].peer === peer) claims.splice(i, 1)
        }
      })
    },
  })
  t.after(() => server.close())
  return {
    address: server.address,
    addresses,
    registrations,
    disconnect: () => Promise.all([...peers].map((peer) => peer.close())),
    get connections() { return connections },
  }
}

test('client uses the four discovery methods on one TCP connection', async (t) => {
  const server = await startRegistry(t)
  const client = await RegistryClient.connect(server.address)
  t.after(() => client.close())

  assert.deepEqual(await client.discovery.register(orders), { registered: ['orders'] })
  await client.discovery.register({ ...otherAddress, services: ['orders'] })
  assert.deepEqual(await client.discovery.list({ service: 'orders' }), [address, otherAddress])
  assert.deepEqual(await client.discovery.pick({ service: 'orders' }), address)
  assert.deepEqual(await client.discovery.list({ service: 'missing' }), [])
  assert.equal(await client.discovery.pick({ service: 'missing' }), null)
  assert.equal(await client.discovery.unregister(orders), undefined)
  assert.deepEqual(await client.discovery.list({ service: 'orders' }), [otherAddress])
  assert.equal(server.connections, 1)

  const closed = client.close()
  assert.equal(client.close(), closed)
  await closed
  assert.equal(client.state, 'closed')
  await waitFor(() => server.addresses('orders').length === 0)
})

test('an exhausted control connection drains in-flight queries and restores confirmed registrations', {
  timeout: 5_000,
}, async t => {
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve(undefined))
  const server = await startRegistry(t, {
    async pick({ service }) {
      if (service !== 'held') return
      entered.resolve(undefined)
      await release.promise
    },
  })
  const client = await RegistryClient.connect(server.address)
  t.after(() => client.close())
  const registration = { ...address, services: ['orders', 'refunds'] }
  await client.discovery.register(registration)
  const held = client.discovery.pick({ service: 'held' })
  void held.catch(() => {})
  await Promise.race([entered.promise, held])

  const nextCallId = Object.getOwnPropertyDescriptor(MessageModem.prototype, 'nextCallId')?.get
  assert.ok(nextCallId)
  const advance = t.mock.getter(MessageModem.prototype, 'nextCallId', /** @this {MessageModem} */ function () {
    const next = nextCallId.call(this)
    return next === 5 ? MAX_CALL_ID : next
  })
  assert.deepEqual(await client.discovery.pick({ service: 'orders' }), address)
  advance.mock.restore()
  await assert.rejects(client.discovery.list({ service: 'orders' }), { code: 'RESOURCE_EXHAUSTED' })
  await assert.rejects(client.discovery.unregister(refunds), { code: 'RESOURCE_EXHAUSTED' })
  assert.equal(server.connections, 1)

  release.resolve(undefined)
  assert.equal(await held, null)
  assert.equal(client.state, 'reconnecting')
  await waitFor(() => server.connections === 2 && client.state === 'ready')
  assert.deepEqual(await client.discovery.list({ service: 'orders' }), [address])
  assert.deepEqual(await client.discovery.list({ service: 'refunds' }), [])
  assert.deepEqual(server.registrations, [registration, orders])
})

for (const action of ['reconnect', 'shutdown']) {
  test(`Registry ${action} waits for the previous control socket to close`, { timeout: 5_000 }, async t => {
    const server = await startRegistry(t)
    const releaseClose = deferred()
    /** @type {string[]} */
    const events = []
    const createConnection = net.createConnection
    const dial = t.mock.method(net, 'createConnection', (
      /** @type {import('node:net').NetConnectOpts} */ options,
    ) => {
      const socket = createConnection(options)
      if ('port' in options && options.port === server.address.port) {
        if (!events.length) {
          const destroy = socket.destroy.bind(socket)
          t.mock.method(socket, 'destroy', (/** @type {Error | undefined} */ error) => {
            void releaseClose.promise.then(() => { destroy(error) })
            return socket
          })
          socket.once('close', () => events.push('closed'))
        }
        events.push('dial')
      }
      return socket
    })
    syncBuiltinESMExports()
    t.after(() => {
      releaseClose.resolve(undefined)
      dial.mock.restore()
      syncBuiltinESMExports()
    })

    const client = await RegistryClient.connect(server.address)
    t.after(() => client.close())
    await client.discovery.register(orders)
    await server.disconnect()
    await waitFor(() => client.state === 'reconnecting')
    assert.deepEqual(events, ['dial'])

    if (action === 'shutdown') {
      const closing = client.close()
      assert.equal(await Promise.race([closing.then(() => true), yieldToIo(false)]), false)
      releaseClose.resolve(undefined)
      await closing
      assert.deepEqual(events, ['dial', 'closed'])
      return
    }

    await delay(250)
    assert.deepEqual(events, ['dial'])
    releaseClose.resolve(undefined)
    await waitFor(() => client.state === 'ready')
    assert.deepEqual(events, ['dial', 'closed', 'dial'])
    assert.deepEqual(await client.discovery.list({ service: 'orders' }), [address])
  })
}

test('a pick signal cancels the Registry RPC while preserving the control connection', { timeout: 5_000 }, async (t) => {
  /** @type {() => void} */
  let markStarted = () => {}
  const started = new Promise((resolve) => { markStarted = () => resolve(undefined) })
  /** @type {() => void} */
  let markAborted = () => {}
  const aborted = new Promise((resolve) => { markAborted = () => resolve(undefined) })
  const query = { service: 'orders', exclude: [otherAddress] }
  const server = await startRegistry(t, {
    async pick(received, signal) {
      if (received.service !== query.service) return
      assert.deepEqual(received, query)
      markStarted()
      if (!signal.aborted) await once(signal, 'abort')
      markAborted()
    },
  })
  const client = await RegistryClient.connect(server.address, { timeoutMs: 500 })
  t.after(() => client.close())

  const controller = new AbortController()
  const result = assert.rejects(client.discovery.pick(query, { signal: controller.signal }), { code: 'CANCELLED' })
  await started
  controller.abort()
  await result
  await aborted
  assert.equal(await client.discovery.pick({ service: 'other' }), null)
  assert.equal(server.connections, 1)
  assert.equal(client.state, 'ready')
})

test('a withdrawal closes the restoring connection before its blocked acknowledgement', async (t) => {
  let blockRestore = false
  let restoreStarted = false
  let restoreAborted = false
  const server = await startRegistry(t, {
    async register(request, signal) {
      if (blockRestore && request.services.includes('orders')) {
        blockRestore = false
        restoreStarted = true
        await once(signal, 'abort')
        restoreAborted = true
      }
    },
  })
  const client = await RegistryClient.connect(server.address, { timeoutMs: 30_000 })
  t.after(() => client.close())
  await client.discovery.register(orders)
  await client.discovery.register({ ...address, services: ['reports'] })
  await client.discovery.register({ ...otherAddress, services: ['orders'] })
  blockRestore = true
  await server.disconnect()
  await waitFor(() => restoreStarted)
  assert.equal(client.state, 'reconnecting')
  await assert.rejects(client.discovery.register({ ...address, services: ['unconfirmed'] }), { code: 'UNAVAILABLE' })
  await assert.rejects(client.discovery.list({ service: 'orders' }), { code: 'UNAVAILABLE' })
  await assert.rejects(client.discovery.pick({ service: 'orders' }), { code: 'UNAVAILABLE' })
  assert.deepEqual(server.addresses('reports'), [address])
  await client.discovery.unregister({ ...address, services: ['reports'] })
  await waitFor(() => restoreAborted)
  await waitFor(() => server.addresses('reports').length === 0)
  await waitFor(() => client.state === 'ready')

  assert.deepEqual(server.registrations[3], { ...address, services: ['orders', 'reports'] })
  assert.deepEqual(await client.discovery.list({ service: 'orders' }), [address, otherAddress])
  assert.deepEqual(await client.discovery.list({ service: 'reports' }), [])
  assert.deepEqual(await client.discovery.list({ service: 'unconfirmed' }), [])
})

test('short-lived restored connections back off up to a cap until a connection stays ready', {
  timeout: 5_000,
}, async (t) => {
  const realNow = performance.now.bind(performance)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  // Update the named timer import used by the reconnect loop.
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.timers.reset()
    syncBuiltinESMExports()
  })
  t.mock.method(performance, 'now', () => Date.now())
  t.mock.method(Math, 'random', () => 0)
  const dial = t.mock.method(RpcPeer, 'connect')
  const server = await startRegistry(t)
  const client = await RegistryClient.connect(server.address)
  t.after(() => client.close())
  await client.discovery.register(orders)

  /** @param {RegistryClient['state']} state */
  async function waitState(state) {
    const deadline = realNow() + 2_000
    while (client.state !== state) {
      assert.ok(realNow() < deadline, `client did not reach ${state}`)
      await yieldToIo()
    }
  }

  const waits = [100, 200, 400, 800, 1_600, 2_500, 2_500]
  for (const [attempt, wait] of waits.entries()) {
    t.mock.timers.tick(4_999)
    await server.disconnect()
    await waitState('reconnecting')
    t.mock.timers.tick(wait - 1)
    await yieldToIo()
    assert.equal(dial.mock.callCount(), attempt + 1)
    t.mock.timers.tick(1)
    await waitState('ready')
    assert.equal(dial.mock.callCount(), attempt + 2)
  }

  t.mock.timers.tick(5_000)
  await server.disconnect()
  await waitState('reconnecting')
  t.mock.timers.tick(100)
  await waitState('ready')
  assert.equal(dial.mock.callCount(), waits.length + 2)
  assert.deepEqual(await client.discovery.list({ service: 'orders' }), [address])
})

test('an ambiguous register retires its connection and restores only confirmed registrations', async (t) => {
  const server = await startRegistry(t, {
    async register(request, signal) {
      if (request.services.includes('refunds')) await once(signal, 'abort')
    },
  })
  const client = await RegistryClient.connect(server.address, { timeoutMs: 200 })
  t.after(() => client.close())
  await client.discovery.register(orders)
  await assert.rejects(client.discovery.register(refunds), { code: 'DEADLINE_EXCEEDED' })
  await waitFor(() => client.state === 'ready')

  assert.equal(server.connections, 2)
  assert.deepEqual(await client.discovery.list({ service: 'orders' }), [address])
  assert.deepEqual(await client.discovery.list({ service: 'refunds' }), [])
})

test('a withdrawal queued during registration removes the confirmed service before reconnect', async (t) => {
  let acknowledge = () => {}
  const acknowledgement = new Promise((resolve) => { acknowledge = () => resolve(undefined) })
  t.after(() => acknowledge())
  const server = await startRegistry(t, { register: () => acknowledgement.then(() => {}) })
  const client = await RegistryClient.connect(server.address)
  t.after(() => client.close())

  const registered = client.discovery.register(orders)
  const removed = client.discovery.unregister(orders)
  await waitFor(() => server.registrations.length === 1)
  acknowledge()
  await Promise.all([registered, removed])
  await server.disconnect()
  await waitFor(() => client.state === 'reconnecting')
  await waitFor(() => client.state === 'ready')

  assert.deepEqual(server.registrations, [orders])
  assert.deepEqual(await client.discovery.list({ service: 'orders' }), [])
})

test('closing during replay cancels the candidate connection and leaves the client closed', async (t) => {
  let restoring = false
  const server = await startRegistry(t, {
    async register(_, signal) {
      if (restoring) await once(signal, 'abort')
    },
  })
  const client = await RegistryClient.connect(server.address)
  t.after(() => client.close())
  await client.discovery.register(orders)

  restoring = true
  await server.disconnect()
  await waitFor(() => server.registrations.length === 2)
  assert.equal(client.state, 'reconnecting')
  await client.close()
  assert.equal(client.state, 'closed')
  await waitFor(() => server.addresses('orders').length === 0)
  await assert.rejects(client.discovery.list({ service: 'orders' }), { code: 'UNAVAILABLE' })
  assert.equal(server.connections, 2)
})

test('list rejects when a finite address snapshot fails after a batch', async (t) => {
  const server = await startRegistry(t, {
    async *list() {
      yield [address]
      throw new RpcError('UNAVAILABLE', 'snapshot interrupted')
    },
  })
  const client = await RegistryClient.connect(server.address)
  t.after(() => client.close())

  await assert.rejects(client.discovery.list({ service: 'orders' }), { code: 'UNAVAILABLE' })
  assert.equal(client.state, 'ready')
})

test('disposing the Cordis plugin cancels its initial handshake', async (t) => {
  const listener = createServer()
  t.after(() => listener.close())
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const socketAccepted = once(listener, 'connection')
  const bound = listener.address()
  assert.ok(bound && typeof bound !== 'string')
  const ctx = new Context()
  const fiber = ctx.plugin(registry, { address: { host: '127.0.0.1', port: bound.port } })
  const [socket] = await socketAccepted
  socket.resume()
  const closed = once(socket, 'close')

  await fiber.dispose()
  await closed
  assert.equal(ctx.get('registryClient'), undefined)
})
