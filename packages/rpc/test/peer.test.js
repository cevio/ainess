import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import test from 'node:test'
import { RpcClient, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

/** @param {string} value */
const bytes = value => Buffer.from(value)

/** @param {Uint8Array} value */
const decode = value => Buffer.from(value).toString()

function latch() {
  let release = () => {}
  const promise = new Promise(resolve => { release = () => resolve(undefined) })
  return { promise, resolve: release }
}

/** @param {AbortSignal} signal */
function untilAborted(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }))
}

/** @param {AsyncIterable<Uint8Array>} stream */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(decode(chunk))
  return chunks
}

/**
 * @param {import('node:test').TestContext} t
 * @param {readonly import('@ainess/rpc').RpcMethod[]} serverMethods
 * @param {readonly import('@ainess/rpc').RpcMethod[]} clientMethods
 */
async function startPeers(t, serverMethods, clientMethods) {
  const ready = latch()
  /** @type {RpcPeer | undefined} */
  let accepted
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: serverMethods,
    onPeer(peer) {
      accepted = peer
      ready.resolve()
    },
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address, {
    signal: AbortSignal.timeout(2_000),
    methods: clientMethods,
  })
  t.after(() => client.close())
  await ready.promise
  assert.ok(accepted)
  return { client, accepted }
}

test('a single TCP connection accepts concurrent first calls in both directions', { timeout: 5_000 }, async t => {
  const toServerStarted = latch()
  const toClientStarted = latch()
  const ready = latch()
  /** @type {RpcPeer | undefined} */
  let accepted
  let connections = 0
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    onPeer(peer) {
      accepted = peer
      connections++
      peer.register({
        name: 'same.name',
        mode: RpcMode.Unary,
        async handle({ data }) {
          toServerStarted.resolve()
          await toClientStarted.promise
          return bytes(`server:${decode(data)}`)
        },
      })
      ready.resolve()
    },
  })
  t.after(() => {
    toServerStarted.resolve()
    toClientStarted.resolve()
    return server.close()
  })
  const client = await RpcPeer.connect(server.address, { methods: [{
    name: 'same.name',
    mode: RpcMode.Unary,
    async handle({ data }) {
      toClientStarted.resolve()
      await toServerStarted.promise
      return bytes(`client:${decode(data)}`)
    },
  }] })
  t.after(() => client.close())

  const toServer = client.request('same.name', bytes('forward'), { timeoutMs: 2_000 })
  void toServer.catch(() => {})
  await ready.promise
  assert.ok(accepted)
  const toClient = accepted.request('same.name', bytes('reverse'), { timeoutMs: 2_000 })
  assert.deepEqual((await Promise.all([toServer, toClient])).map(decode), ['server:forward', 'client:reverse'])
  assert.equal(connections, 1)
})

test('onPeer can start a reverse call before the dialer finishes connecting', { timeout: 5_000 }, async t => {
  const earlyStarted = latch()
  /** @type {Promise<Uint8Array> | undefined} */
  let early
  let connections = 0
  let connected = false
  let startedBeforeConnect = false
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [{ name: 'followUp', mode: RpcMode.Unary, handle: ({ data }) => data }],
    onPeer(peer) {
      connections++
      startedBeforeConnect = !connected
      early = peer.request('welcome', bytes('from acceptor'), { timeoutMs: 2_000 })
      void early.catch(() => {})
      earlyStarted.resolve()
    },
  })
  t.after(() => server.close())

  // Delay the acceptor's HELLO until onPeer has started its request.
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()
  const relay = createServer(dialer => {
    const acceptor = createConnection(server.address)
    sockets.add(dialer).add(acceptor)
    dialer.on('error', () => {})
    acceptor.on('error', () => {})
    dialer.pipe(acceptor)
    void earlyStarted.promise.then(() => { acceptor.pipe(dialer) })
  })
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    return new Promise(resolve => relay.close(() => resolve(undefined)))
  })
  relay.listen(0, '127.0.0.1')
  await once(relay, 'listening')
  const address = relay.address()
  assert.ok(address && typeof address !== 'string')

  const client = await RpcPeer.connect({ host: address.address, port: address.port }, {
    signal: AbortSignal.timeout(2_000),
    methods: [{ name: 'welcome', mode: RpcMode.Unary, handle: ({ data }) => bytes(`received ${decode(data)}`) }],
  })
  connected = true
  t.after(() => client.close())
  assert.ok(early)
  assert.equal(startedBeforeConnect, true)
  assert.equal(decode(await early), 'received from acceptor')
  assert.equal(decode(await client.request('followUp', bytes('same connection'))), 'same connection')
  assert.equal(connections, 1)
})

test('a listener handler can await nested RPC calls on its own peer before replying', { timeout: 5_000 }, async t => {
  const { client, accepted } = await startPeers(t, [
    {
      name: 'start',
      mode: RpcMode.Unary,
      async handle({ data, peer }) {
        assert.equal(peer, accepted)
        return peer.request('reverse', data, { timeoutMs: 2_000 })
      },
    },
    { name: 'finish', mode: RpcMode.Unary, handle: ({ data }) => bytes(`done:${decode(data)}`) },
  ], [{
    name: 'reverse',
    mode: RpcMode.Unary,
    async handle({ data, peer }) {
      assert.equal(peer, client)
      return peer.request('finish', data, { timeoutMs: 2_000 })
    },
  }])

  assert.equal(decode(await client.request('start', bytes('round trip'), { timeoutMs: 2_000 })), 'done:round trip')
})

test('the connected peer can add and remove a reverse method after its handshake', { timeout: 5_000 }, async t => {
  assert.equal(RpcClient, RpcPeer)
  const { client, accepted } = await startPeers(t, [], [])
  await assert.rejects(accepted.request('probe'), { code: 'NOT_FOUND' })
  const unregister = client.register({ name: 'probe', mode: RpcMode.Unary, handle: () => bytes('registered') })
  assert.equal(decode(await accepted.request('probe')), 'registered')
  await unregister()
  await assert.rejects(accepted.request('probe'), { code: 'NOT_FOUND' })
})

test('stopping one upload preserves the reverse bidi RPC on the same connection', { timeout: 5_000 }, async t => {
  const forwardWaiting = latch()
  const forwardStopped = latch()
  const reverseReceiving = latch()
  t.after(() => {
    forwardWaiting.resolve()
    forwardStopped.resolve()
    reverseReceiving.resolve()
  })
  const { client, accepted } = await startPeers(t, [{
    name: 'duplex',
    mode: RpcMode.Bidi,
    async *handle({ input, signal, peer }) {
      assert.equal(peer, accepted)
      for await (const chunk of input) {
        assert.equal(decode(chunk), 'forward upload')
        await Promise.all([forwardWaiting.promise, reverseReceiving.promise])
        input.stop()
      }
      await forwardStopped.promise
      assert.equal(signal.aborted, false)
      yield bytes('forward response after stop')
    },
  }], [{
    name: 'duplex',
    mode: RpcMode.Bidi,
    async *handle({ input, signal, peer }) {
      assert.equal(peer, client)
      for await (const chunk of input) {
        reverseReceiving.resolve()
        assert.equal(signal.aborted, false)
        yield bytes(`reverse response:${decode(chunk)}`)
      }
      yield bytes('reverse completed')
    },
  }])

  const forward = client.stream('duplex', {
    timeoutMs: 2_000,
    async *input(signal) {
      yield bytes('forward upload')
      forwardWaiting.resolve()
      await untilAborted(signal)
      forwardStopped.resolve()
    },
  })
  const reverse = accepted.stream('duplex', {
    timeoutMs: 2_000,
    async *input(signal) {
      yield bytes('first')
      await forwardStopped.promise
      assert.equal(signal.aborted, false)
      yield bytes('last')
    },
  })
  assert.deepEqual(await Promise.all([collect(forward), collect(reverse)]), [
    ['forward response after stop'],
    ['reverse response:first', 'reverse response:last', 'reverse completed'],
  ])
})

test('closing a peer settles outstanding calls and handlers in both directions', { timeout: 5_000 }, async t => {
  const toServerStarted = latch()
  const toClientStarted = latch()
  const toServerAborted = latch()
  const toClientAborted = latch()
  const { client, accepted } = await startPeers(t, [{
    name: 'wait',
    mode: RpcMode.Unary,
    async handle({ signal }) {
      toServerStarted.resolve()
      await untilAborted(signal)
      toServerAborted.resolve()
      return bytes('')
    },
  }], [{
    name: 'wait',
    mode: RpcMode.Unary,
    async handle({ signal }) {
      toClientStarted.resolve()
      await untilAborted(signal)
      toClientAborted.resolve()
      return bytes('')
    },
  }])

  const toServer = assert.rejects(client.request('wait'), { code: 'UNAVAILABLE' })
  const toClient = assert.rejects(accepted.request('wait'), { code: 'UNAVAILABLE' })
  await Promise.all([toServerStarted.promise, toClientStarted.promise])
  await client.close()
  await Promise.all([toServer, toClient, toServerAborted.promise, toClientAborted.promise])
})
