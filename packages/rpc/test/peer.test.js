import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createConnection, createServer, Socket } from 'node:net'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { RpcClient, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'
import { encodeHeader, encodeHello, FrameType } from '../dist/wire.js'

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

/**
 * @param {RpcPeer} peer
 * @returns {Promise<import('@ainess/rpc').RpcCloseInfo>}
 */
function waitForClose(peer) {
  return new Promise(resolve => { peer.onClose(resolve) })
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

test('dial listener cleanup leaves the ready peer usable', { timeout: 5_000 }, async t => {
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [{ name: 'probe', mode: RpcMode.Unary, handle: () => bytes('ready') }],
  })
  t.after(() => server.close())

  for (const behavior of ['throws', 'aborts']) {
    const controller = new AbortController()
    const { signal } = controller
    const remove = signal.removeEventListener.bind(signal)
    /**
     * @param {string} type
     * @param {EventListenerOrEventListenerObject} listener
     * @param {boolean | EventListenerOptions} [options]
     */
    function removeDuringCleanup(type, listener, options) {
      if (behavior === 'throws') throw new Error('observer cleanup failed')
      controller.abort()
      remove(type, listener, options)
    }
    signal.removeEventListener = removeDuringCleanup
    const peer = await RpcPeer.connect(server.address, { signal })
    t.after(() => peer.close())
    controller.abort()
    assert.equal(decode(await peer.request('probe', { timeoutMs: 1_000 })), 'ready')
  }
})

test('a failed handshake preserves its error when dial listener cleanup throws', { timeout: 5_000 }, async t => {
  const listener = createServer(socket => {
    socket.on('error', () => {})
    socket.resume()
    socket.end()
  })
  t.after(() => new Promise(resolve => listener.close(() => resolve(undefined))))
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')

  const { signal } = new AbortController()
  signal.removeEventListener = () => { throw new Error('observer cleanup failed') }
  await assert.rejects(RpcPeer.connect({ host: address.address, port: address.port }, { signal }), {
    code: 'UNAVAILABLE',
  })
})

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

test('missing methods and mode mismatches fail only their own call in both directions', { timeout: 5_000 }, async t => {
  let unexpectedCalls = 0
  /** @type {import('@ainess/rpc').RpcMethod[]} */
  const methods = [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    {
      name: 'unaryOnly',
      mode: RpcMode.Unary,
      handle() {
        unexpectedCalls++
        return bytes('unexpected')
      },
    },
    {
      name: 'streamOnly',
      mode: RpcMode.ServerStream,
      async *handle() {
        unexpectedCalls++
        yield bytes('unexpected')
      },
    },
  ]
  const { accepted, client } = await startPeers(t, methods, methods)
  /** @type {Promise<unknown>[]} */
  const cleanups = []
  /** @param {AbortSignal} signal */
  async function* input(signal) {
    const stopped = latch()
    cleanups.push(stopped.promise)
    try {
      yield Buffer.alloc(64 * 1024)
      await untilAborted(signal)
    } finally {
      stopped.resolve()
    }
  }

  await Promise.all([client, accepted].map(async peer => {
    const options = { timeoutMs: 2_000 }
    const upload = { ...options, input }
    /** @type {[string, (name: string) => Promise<unknown>][]} */
    const cases = [
      ['streamOnly', name => peer.request(name, options)],
      ['unaryOnly', name => peer.stream(name, options).next()],
      ['unaryOnly', name => peer.request(name, upload)],
      ['unaryOnly', name => peer.stream(name, upload).next()],
    ]
    for (const [wrongMode, invoke] of cases) {
      await assert.rejects(invoke('missing'), { code: 'NOT_FOUND', message: 'Unknown RPC method missing' })
      await assert.rejects(invoke(wrongMode), { code: 'INVALID_ARGUMENT' })
      assert.equal(decode(await peer.request('echo', bytes('connected'), options)), 'connected')
    }
  }))
  assert.ok(cleanups.length > 0)
  await Promise.all(cleanups)
  assert.equal(unexpectedCalls, 0)
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
  const clientClosed = waitForClose(client)
  const acceptedClosed = waitForClose(accepted)
  await Promise.all([toServerStarted.promise, toClientStarted.promise])
  await Promise.all([client.close(), client.close()])
  await Promise.all([toServer, toClient, toServerAborted.promise, toClientAborted.promise])
  const [local, remote] = await Promise.all([clientClosed, acceptedClosed])
  assert.equal(local.reason, 'local')
  assert.equal(remote.reason, 'remote')
  assert.equal(local.error.code, 'UNAVAILABLE')
  assert.equal(remote.error.code, 'UNAVAILABLE')
})

test('TCP keepalive is enabled on both ends of a peer connection', { timeout: 5_000 }, async t => {
  const keepalive = t.mock.method(Socket.prototype, 'setKeepAlive')
  await startPeers(t, [], [])

  assert.deepEqual(keepalive.mock.calls.map(call => call.arguments), [[true, 30_000], [true, 30_000]])
  assert.notEqual(keepalive.mock.calls[0].this, keepalive.mock.calls[1].this)
})

test('close listeners are independent, fire once, and replay the reason to late subscribers', { timeout: 5_000 }, async t => {
  const { client } = await startPeers(t, [], [])
  /** @type {string[]} */
  const notifications = []
  const listener = () => { notifications.push('active') }
  const unsubscribe = client.onClose(listener)
  client.onClose(listener)
  unsubscribe()
  unsubscribe()
  client.onClose(() => {
    notifications.push('throw')
    throw new Error('close observer failed')
  })
  client.onClose(async () => {
    notifications.push('reject')
    throw new Error('async close observer failed')
  })
  const notified = waitForClose(client)

  await Promise.all([client.close(), client.close()])
  const initial = await notified
  assert.deepEqual(notifications.sort(), ['active', 'reject', 'throw'])

  const late = waitForClose(client)
  const unsubscribeLate = client.onClose(() => { notifications.push('cancelled late') })
  unsubscribeLate()
  client.onClose(() => { notifications.push('late') })
  assert.equal(notifications.includes('late'), false)
  assert.equal(await late, initial)
  assert.deepEqual(notifications.sort(), ['active', 'late', 'reject', 'throw'])
})

test('retained close listener disposers do not keep closed peers alive', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/close-listener-retention.mjs', import.meta.url))
  await promisify(execFile)(process.execPath, ['--expose-gc', fixture], { timeout: 5_000 })
})

test('retained terminal response iterators do not keep closed peers alive', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/stream-retention.mjs', import.meta.url))
  await promisify(execFile)(process.execPath, ['--expose-gc', fixture], { timeout: 5_000 })
})

test('a truncated frame reports a connection error to the accepted peer', { timeout: 5_000 }, async t => {
  const ready = latch()
  /** @type {RpcPeer | undefined} */
  let accepted
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    onPeer(peer) {
      accepted = peer
      ready.resolve()
    },
  })
  t.after(() => server.close())
  const socket = createConnection(server.address)
  t.after(() => { socket.destroy() })
  socket.on('error', () => {})
  socket.resume()
  const hello = { type: FrameType.Hello, id: 0, flags: 0, body: encodeHello() }
  socket.write(Buffer.concat([encodeHeader(hello), hello.body]))
  await ready.promise
  assert.ok(accepted)
  const closed = waitForClose(accepted)
  socket.end(Buffer.of(0))

  const info = await closed
  assert.equal(info.reason, 'error')
  assert.equal(info.error.code, 'UNAVAILABLE')
  assert.match(info.error.message, /truncated/i)
})
