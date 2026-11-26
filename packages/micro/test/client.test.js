import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import test from 'node:test'
import { setImmediate as immediate } from 'node:timers/promises'
import { defineApp, use } from '@ainess/framework'
import { createMicroClient, micro } from '@ainess/micro'
import { registry, RegistryClient } from '@ainess/registry-client'
import { RegistryServer } from '@ainess/registry-server'
import { RpcError, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

const host = '127.0.0.1'

function latch() {
  let release = () => {}
  const promise = new Promise(resolve => { release = () => resolve(undefined) })
  return { promise, release }
}

/**
 * @param {import('node:test').TestContext} t
 * @param {readonly import('@ainess/rpc').RpcMethod[]} [methods]
 */
async function ownServer(t, methods = [{ name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data }]) {
  /** @type {import('@ainess/rpc').RpcPeer[]} */
  const peers = []
  const server = await RpcServer.listen({
    host,
    port: 0,
    methods,
    onPeer: peer => peers.push(peer),
  })
  t.after(() => server.close())
  return { address: server.address, peers }
}

/** @param {import('node:test').TestContext} t */
async function ownRegistry(t) {
  const server = await RegistryServer.listen({ host, port: 0 })
  t.after(() => server.close())
  const client = await RegistryClient.connect(server.address)
  t.after(() => client.close())
  return { address: server.address, client }
}

/** @param {import('node:test').TestContext} t */
async function ownBrokenServer(t) {
  const server = createServer(socket => {
    socket.on('error', () => {})
    socket.destroy()
  })
  server.listen({ host, port: 0 })
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return { host, port: address.port }
}

/** @param {Uint8Array} reply */
const decode = reply => Buffer.from(reply).toString()

test('malformed addresses from discovery are reported as invalid addresses', async t => {
  const results = [{ host: 12n, port: 7000 }, undefined]
  const client = createMicroClient({
    discovery: {
      async pick() {
        const result = /** @type {unknown} */ (results.shift())
        return /** @type {import('@ainess/rpc').RpcAddress} */ (result)
      },
    },
  })
  t.after(() => client.close())

  await assert.rejects(client.request('orders', 'echo'), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(client.request('shipping', 'echo'), { code: 'INVALID_ARGUMENT' })
})

test('cold concurrent requests share one pick per service and one connection per address', {
  timeout: 10_000,
}, async t => {
  const endpoint = await ownServer(t)
  const allPicksStarted = latch()
  const allowPick = latch()
  t.after(allowPick.release)
  /** @type {string[]} */
  const services = []
  const client = createMicroClient({
    discovery: {
      async pick({ service }) {
        services.push(service)
        if (services.includes('orders') && services.includes('inventory')) allPicksStarted.release()
        await allowPick.promise
        return endpoint.address
      },
    },
  })
  t.after(() => client.close())

  const orders = Array.from({ length: 100 }, (_, i) =>
    client.request('orders', 'echo', Buffer.from(String(i))).then(decode))
  const inventory = client.request('inventory', 'echo', Buffer.from('inventory')).then(decode)
  const replies = Promise.all([...orders, inventory])
  void replies.catch(() => {})
  await allPicksStarted.promise
  allowPick.release()

  assert.deepEqual(await replies, [...Array.from({ length: 100 }, (_, i) => String(i)), 'inventory'])
  assert.deepEqual(services.sort(), ['inventory', 'orders'])
  assert.equal(endpoint.peers.length, 1)
  assert.equal(decode(await client.request('orders', 'echo', Buffer.from('again'))), 'again')
  assert.equal(services.length, 2)
  assert.equal(endpoint.peers.length, 1)
})

test('distinct services share one connection during simultaneous cold lookup', {
  timeout: 10_000,
}, async t => {
  const endpoint = await ownServer(t)
  const firstPick = latch()
  const allowPick = latch()
  t.after(allowPick.release)
  const client = createMicroClient({
    discovery: {
      async pick() {
        firstPick.release()
        await allowPick.promise
        return endpoint.address
      },
    },
  })
  t.after(() => client.close())

  const first = client.request('orders', 'echo', Buffer.from('orders')).then(decode)
  await firstPick.promise
  const second = client.request('inventory', 'echo', Buffer.from('inventory')).then(decode)
  const replies = Promise.all([first, second])
  void replies.catch(() => {})
  await immediate()
  allowPick.release()
  assert.deepEqual(await replies, ['orders', 'inventory'])
  assert.equal(endpoint.peers.length, 1)
})

test('connect failure shares one Registry retry with the failed address excluded', { timeout: 10_000 }, async t => {
  const directory = await ownRegistry(t)
  const failedAddress = await ownBrokenServer(t)
  const healthy = await ownServer(t)
  /** @type {import('@ainess/registry-client').PickQuery[]} */
  const queries = []
  for (const address of [failedAddress, healthy.address]) {
    await directory.client.discovery.register({ ...address, services: ['orders'] })
  }
  const client = createMicroClient({
    discovery: {
      pick(query) {
        queries.push(query)
        return directory.client.discovery.pick(query)
      },
    },
  })
  t.after(() => client.close())

  const requests = Array.from({ length: 40 }, () => client.request('orders', 'echo', Buffer.from('ready')).then(decode))
  assert.deepEqual(await Promise.all(requests), Array.from({ length: 40 }, () => 'ready'))
  assert.deepEqual(queries.map(({ service, exclude = [] }) => ({ service, exclude })), [
    { service: 'orders', exclude: [] },
    { service: 'orders', exclude: [failedAddress] },
  ])
  assert.equal(healthy.peers.length, 1)
})

test('a failed alternate ends a connect attempt without picking a third address', { timeout: 10_000 }, async t => {
  const directory = await ownRegistry(t)
  const first = await ownBrokenServer(t)
  const second = await ownBrokenServer(t)
  const healthy = await ownServer(t)
  for (const address of [first, second, healthy.address]) {
    await directory.client.discovery.register({ ...address, services: ['orders'] })
  }
  /** @type {import('@ainess/registry-client').PickQuery[]} */
  const queries = []
  const client = createMicroClient({
    discovery: {
      pick(query) {
        queries.push(query)
        return directory.client.discovery.pick(query)
      },
    },
  })
  t.after(() => client.close())

  await assert.rejects(client.request('orders', 'echo'), { code: 'UNAVAILABLE' })
  assert.equal(queries.length, 2)
  assert.deepEqual(queries[1].exclude, [first])
  assert.equal(healthy.peers.length, 0)
})

test('canceling a caller waiting for discovery keeps the shared acquisition alive', { timeout: 10_000 }, async t => {
  const endpoint = await ownServer(t)
  const pickStarted = latch()
  const allowPick = latch()
  t.after(allowPick.release)
  let picks = 0
  const client = createMicroClient({
    discovery: {
      async pick() {
        picks++
        pickStarted.release()
        await allowPick.promise
        return endpoint.address
      },
    },
  })
  t.after(() => client.close())

  const controller = new AbortController()
  const canceled = assert.rejects(client.request('orders', 'echo', undefined, { signal: controller.signal }), {
    code: 'CANCELLED',
  })
  await pickStarted.promise
  const remaining = client.request('orders', 'echo', Buffer.from('remaining'))
  controller.abort()
  try {
    await canceled
    assert.equal(endpoint.peers.length, 0)
  } finally {
    allowPick.release()
  }
  assert.equal(decode(await remaining), 'remaining')
  assert.equal(picks, 1)
  assert.equal(endpoint.peers.length, 1)
})

test('one Micro connection carries more than 4096 in-flight requests without a second pick', {
  timeout: 15_000,
}, async t => {
  const count = 4_608
  const allEntered = latch()
  const allowReply = latch()
  t.after(allowReply.release)
  let executions = 0
  const endpoint = await ownServer(t, [{
    name: 'echo',
    mode: RpcMode.Unary,
    async handle({ data }) {
      if (++executions === count) allEntered.release()
      await allowReply.promise
      return data
    },
  }])
  let picks = 0
  const client = createMicroClient({
    discovery: { async pick() { picks++; return endpoint.address } },
    timeoutMs: 10_000,
  })
  t.after(() => client.close())

  const values = Array.from({ length: count }, (_, index) => String(index))
  const results = Promise.all(values.map(value => client.request('orders', 'echo', Buffer.from(value)).then(decode)))
  try {
    await Promise.race([allEntered.promise, results])
    assert.equal(executions, count)
    assert.equal(picks, 1)
    assert.equal(endpoint.peers.length, 1)
  } finally {
    allowReply.release()
  }
  assert.deepEqual(await results, values)
})

test('a paused stream shares a single peer with unary calls and can be returned', { timeout: 10_000 }, async t => {
  const streamClosed = latch()
  const endpoint = await ownServer(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    {
      name: 'events',
      mode: RpcMode.ServerStream,
      async *handle({ signal }) {
        try {
          yield Buffer.from('event')
          if (!signal.aborted) await once(signal, 'abort')
        } finally {
          streamClosed.release()
        }
      },
    },
  ])
  let picks = 0
  const client = createMicroClient({
    discovery: { async pick() { picks++; return endpoint.address } },
  })
  t.after(() => client.close())

  const stream = client.stream('orders', 'events')
  assert.equal(picks, 0)
  const first = await stream.next()
  assert.ok(!first.done)
  assert.equal(decode(first.value), 'event')
  assert.equal(decode(await client.request('orders', 'echo', Buffer.from('concurrent'))), 'concurrent')
  assert.equal(endpoint.peers.length, 1)
  await stream.return?.()
  await streamClosed.promise
  assert.equal(decode(await client.request('orders', 'echo', Buffer.from('ready'))), 'ready')
  assert.equal(endpoint.peers.length, 1)
})

test('return interrupts a pending response read and aborts the provider stream', { timeout: 5_000 }, async t => {
  const waitingAtProvider = latch()
  const providerAborted = latch()
  const endpoint = await ownServer(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      yield Buffer.from('first')
      waitingAtProvider.release()
      if (!signal.aborted) await once(signal, 'abort')
      providerAborted.release()
    },
  }])
  const client = createMicroClient({ discovery: { async pick() { return endpoint.address } } })
  t.after(() => client.close())

  const stream = client.stream('orders', 'events', undefined, { timeoutMs: 20_000 })
  const first = await stream.next()
  assert.ok(!first.done)
  assert.equal(decode(first.value), 'first')
  const pending = Promise.allSettled([stream.next()])
  await waitingAtProvider.promise
  assert.equal((await stream.return?.())?.done, true)
  await pending
  await providerAborted.promise
})

test('caller abort closes a provider stream while the iterator is paused between reads', {
  timeout: 5_000,
}, async t => {
  const providerAborted = latch()
  const endpoint = await ownServer(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    {
      name: 'events',
      mode: RpcMode.ServerStream,
      async *handle({ signal }) {
        yield Buffer.from('event')
        if (!signal.aborted) await once(signal, 'abort')
        providerAborted.release()
      },
    },
  ])
  const client = createMicroClient({
    discovery: { async pick({ exclude }) { return exclude?.length ? null : endpoint.address } },
  })
  t.after(() => client.close())

  const controller = new AbortController()
  const stream = client.stream('orders', 'events', undefined, { signal: controller.signal })
  t.after(() => stream.return?.())
  const first = await stream.next()
  assert.ok(!first.done)
  controller.abort()
  await providerAborted.promise
  assert.equal(decode(await client.request('orders', 'echo', Buffer.from('ready'))), 'ready')
  assert.equal(endpoint.peers.length, 1)
})

test('aborting in an observer preserves the RPC failure already received', { timeout: 5_000 }, async t => {
  const codes = /** @type {const} */ (['UNAVAILABLE', 'CANCELLED'])
  const endpoint = await ownServer(t, codes.map(code => ({
    name: code,
    mode: RpcMode.Unary,
    handle() { throw new RpcError(code, 'provider ended the call') },
  })))
  const client = createMicroClient({ discovery: { async pick() { return endpoint.address } } })
  t.after(() => client.close())

  for (const code of codes) {
    const controller = new AbortController()
    await assert.rejects(client.request('orders', code, undefined, {
      signal: controller.signal,
      onFailure() { controller.abort() },
    }), { code, message: 'provider ended the call' })
  }
})

test('a connection loss after dispatch rejects the call without replaying it', { timeout: 10_000 }, async t => {
  const directory = await ownRegistry(t)
  let executions = 0
  const failing = await ownServer(t, [{
    name: 'echo',
    mode: RpcMode.Unary,
    handle({ peer, data }) {
      executions++
      void peer.close()
      return data
    },
  }])
  const healthy = await ownServer(t)
  for (const { address } of [failing, healthy]) {
    await directory.client.discovery.register({ ...address, services: ['orders'] })
  }
  /** @type {import('@ainess/registry-client').PickQuery[]} */
  const picks = []
  const client = createMicroClient({
    discovery: {
      pick(query) {
        picks.push(query)
        return directory.client.discovery.pick(query)
      },
    },
  })
  t.after(() => client.close())

  await assert.rejects(client.request('orders', 'echo', Buffer.from('apply')), { code: 'UNAVAILABLE' })
  assert.equal(executions, 1)
  assert.equal(picks.length, 1)
  assert.equal(healthy.peers.length, 0)

  assert.equal(decode(await client.request('orders', 'echo', Buffer.from('next'))), 'next')
  assert.equal(executions, 1)
  assert.equal(picks.length, 2)
  assert.deepEqual(picks[1].exclude, [failing.address])
  assert.equal(healthy.peers.length, 1)
})

test('closing during selection rejects pending callers and never dials a late result', { timeout: 10_000 }, async t => {
  const endpoint = await ownServer(t)
  const dial = t.mock.method(RpcPeer, 'connect')
  const pickStarted = latch()
  const allowPick = latch()
  const pickSettled = latch()
  t.after(allowPick.release)
  const client = createMicroClient({
    discovery: {
      async pick() {
        pickStarted.release()
        await allowPick.promise
        pickSettled.release()
        return endpoint.address
      },
    },
  })
  t.after(() => client.close())

  const pending = assert.rejects(client.request('orders', 'echo'))
  await pickStarted.promise
  await client.close()
  await pending
  allowPick.release()
  await pickSettled.promise
  await immediate()
  assert.equal(dial.mock.callCount(), 0)
})

test('a rejected discovery is handled when the provider synchronously closes the client', {
  timeout: 5_000,
}, async t => {
  const client = createMicroClient({
    discovery: {
      pick() {
        void client.close()
        return Promise.reject(new Error('provider stopped during lookup'))
      },
    },
  })
  t.after(() => client.close())
  await assert.rejects(client.request('orders', 'echo'), { code: 'UNAVAILABLE' })
  await client.close()
  await immediate()
})

test('Cordis injects registry discovery and releases the business peer on disposal', { timeout: 10_000 }, async t => {
  const directory = await ownRegistry(t)
  const endpoint = await ownServer(t)
  await directory.client.discovery.register({ ...endpoint.address, services: ['orders'] })
  const consumer = await defineApp({
    plugins: {
      registry: use(registry, { address: directory.address }),
      micro: use({
        inject: ['registryClient'],
        /** @param {import('@deepseek-ai/cordis').Context} ctx */
        async apply(ctx) {
          await ctx.plugin(micro, { discovery: ctx.registryClient.discovery }).await()
        },
      }),
    },
  }).start()
  t.after(() => consumer.stop())
  assert.equal(endpoint.peers.length, 0)
  const client = consumer.ctx.micro
  assert.equal(decode(await client.request('orders', 'echo', Buffer.from('ready'))), 'ready')
  assert.equal(endpoint.peers.length, 1)
  const closed = latch()
  endpoint.peers[0].onClose(closed.release)
  await consumer.stop()
  await closed.promise
  assert.deepEqual(await directory.client.discovery.pick({ service: 'orders' }), endpoint.address)
})
