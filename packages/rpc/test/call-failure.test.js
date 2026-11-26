import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import test from 'node:test'
import { RpcError, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'
import { errorFrame, frame } from '../dist/messages.js'
import { encodeHeader, encodeHello, FrameDecoder, FrameType, HEADER_SIZE, MAX_BODY } from '../dist/wire.js'

/** @typedef {import('@ainess/rpc').RpcCallFailure} RpcCallFailure */

/**
 * @param {import('node:test').TestContext} t
 * @param {import('@ainess/rpc').RpcMethod[]} methods
 */
async function connect(t, methods) {
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0, methods })
  t.after(() => server.close())
  const peer = await RpcPeer.connect(server.address)
  t.after(() => peer.close())
  return { server, peer }
}

test('an ERROR frame reports the remote source and does not depend on the observer succeeding', {
  timeout: 5_000,
}, async t => {
  const { peer } = await connect(t, [
    {
      name: 'remote-failure',
      mode: RpcMode.Unary,
      handle() { throw new RpcError('UNAVAILABLE', 'temporarily unavailable') },
    },
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
  ])
  /** @type {RpcCallFailure[]} */
  const failures = []
  const startedAt = performance.now()
  await assert.rejects(peer.request('remote-failure', {
    onFailure(failure) {
      failures.push(failure)
      throw new Error('observer failed')
    },
  }), error => failures.length === 1 && failures[0].error === error)
  assert.equal(failures[0].source, 'remote')
  assert.equal(failures[0].error.code, 'UNAVAILABLE')
  assert.ok(failures[0].sentAt !== undefined && failures[0].sentAt >= startedAt)
  assert.deepEqual(await peer.request('echo', Buffer.of(7)), Buffer.of(7))
})

test('an upload producer error remains local even when it rethrows a remote error', {
  timeout: 5_000,
}, async t => {
  const { peer } = await connect(t, [{
    name: 'remote-failure',
    mode: RpcMode.Unary,
    handle() { throw new RpcError('UNAVAILABLE') },
  }, {
    name: 'upload',
    mode: RpcMode.ClientStream,
    async handle({ input }) {
      for await (const _ of input) {}
      return Buffer.alloc(0)
    },
  }])
  const remoteError = await peer.request('remote-failure').catch(error => error)
  /** @type {RpcCallFailure[]} */
  const failures = []
  await assert.rejects(peer.request('upload', {
    input() { throw remoteError },
    onFailure(failure) { failures.push(failure) },
  }), error => error === remoteError)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'local')
  assert.equal(failures[0].error, remoteError)
  assert.ok(failures[0].sentAt !== undefined)
})

test('cancelling an OPEN queued behind exhausted credit reports an unsent local failure', {
  timeout: 5_000,
}, async t => {
  const listener = createServer(socket => {
    socket.on('error', () => {})
    socket.resume()
    const hello = encodeHello()
    hello.writeUInt32BE(HEADER_SIZE + MAX_BODY, 4)
    const header = encodeHeader({ type: FrameType.Hello, id: 0, flags: 0, body: hello })
    socket.write(Buffer.concat([header, hello]))
  })
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  /** @type {RpcPeer | undefined} */
  let peer
  t.after(async () => {
    await peer?.close()
    await new Promise(resolve => listener.close(() => resolve(undefined)))
  })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  peer = await RpcPeer.connect({ host: '127.0.0.1', port: address.port })

  const draining = peer.request('x', Buffer.alloc(MAX_BODY - 2)).catch(() => {})
  const controller = new AbortController()
  /** @type {RpcCallFailure[]} */
  const failures = []
  const request = peer.request('x', {
    signal: controller.signal,
    onFailure(failure) { failures.push(failure) },
  })
  const reason = new Error('caller stopped waiting')
  controller.abort(reason)
  await assert.rejects(request, { code: 'CANCELLED', cause: reason })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'local')
  assert.equal(failures[0].sentAt, undefined)
  await peer.close()
  await draining
})

test('connection close reports transport provenance for each unfinished call', { timeout: 5_000 }, async t => {
  /** @type {() => void} */
  let markStarted = () => {}
  const started = new Promise(resolve => { markStarted = () => resolve(undefined) })
  const { server, peer } = await connect(t, [{
    name: 'wait',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      markStarted()
      if (!signal.aborted) await once(signal, 'abort')
    },
  }])
  /** @type {RpcCallFailure[]} */
  const failures = []
  /** @type {string[]} */
  const notifications = []
  peer.onClose(() => { notifications.push('closed') })
  const iterator = peer.stream('wait', {
    onFailure(failure) {
      failures.push(failure)
      queueMicrotask(() => { notifications.push('replacement') })
    },
  })
  const finished = assert.rejects(iterator.next(), { code: 'UNAVAILABLE' })
  await started
  await server.close()
  await finished
  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'transport')
  assert.ok(failures[0].sentAt !== undefined)
  assert.deepEqual(notifications, ['closed', 'replacement'])
})

test('a remote error after streaming data reports a started response', { timeout: 5_000 }, async t => {
  const { peer } = await connect(t, [{
    name: 'stream',
    mode: RpcMode.ServerStream,
    async *handle() {
      yield Buffer.of(42)
      throw new RpcError('UNAVAILABLE')
    },
  }])
  /** @type {RpcCallFailure[]} */
  const failures = []
  const iterator = peer.stream('stream', { onFailure(failure) { failures.push(failure) } })
  assert.deepEqual(await iterator.next(), { value: Buffer.of(42), done: false })
  await assert.rejects(iterator.next(), { code: 'UNAVAILABLE' })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'remote')
  assert.equal(failures[0].responseStarted, true)
})

test('a successful unary response and an empty stream each notify exactly once', { timeout: 5_000 }, async t => {
  const { peer } = await connect(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'empty', mode: RpcMode.ServerStream, async *handle() {} },
  ])
  let notifications = 0
  const response = await peer.request('echo', Buffer.of(7), {
    onResponse() {
      notifications++
      throw new Error('observer threw')
    },
  })
  assert.deepEqual(response, Buffer.of(7))
  assert.equal(notifications, 1)
  const stream = peer.stream('empty', {
    async onResponse() {
      notifications++
      throw new Error('observer rejected')
    },
  })
  assert.equal(await stream.next().then(item => item.done), true)
  assert.equal(await stream.next().then(item => item.done), true)
  assert.equal(notifications, 2)
})

test('the first stream data notifies synchronously before a following failure', { timeout: 5_000 }, async t => {
  const listener = createServer(socket => {
    socket.on('error', () => {})
    const decoder = new FrameDecoder()
    socket.on('data', chunk => {
      assert.ok(Buffer.isBuffer(chunk))
      decoder.push(chunk, ({ id, type }) => {
        if (type !== FrameType.Open) return
        const frames = [
          frame(FrameType.Data, id, Buffer.of(1)),
          frame(FrameType.Data, id, Buffer.of(2)),
          errorFrame(id, new RpcError('UNAVAILABLE')),
        ]
        socket.write(Buffer.concat(frames.flatMap(value => [encodeHeader(value), value.body])))
      })
    })
    const hello = frame(FrameType.Hello, 0, encodeHello())
    socket.write(Buffer.concat([encodeHeader(hello), hello.body]))
  })
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  /** @type {RpcPeer | undefined} */
  let peer
  t.after(async () => {
    await peer?.close()
    await new Promise(resolve => listener.close(() => resolve(undefined)))
  })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  peer = await RpcPeer.connect({ host: '127.0.0.1', port: address.port })

  /** @type {string[]} */
  const notifications = []
  const stream = peer.stream('stream', {
    onResponse() { notifications.push('response') },
    onFailure() { notifications.push('failure') },
  })
  assert.deepEqual(await stream.next(), { value: Buffer.of(1), done: false })
  assert.deepEqual(await stream.next(), { value: Buffer.of(2), done: false })
  await assert.rejects(stream.next(), { code: 'UNAVAILABLE' })
  assert.deepEqual(notifications, ['response', 'failure'])
})

test('a response observer can cancel a stream as its first data arrives', { timeout: 5_000 }, async t => {
  const { peer } = await connect(t, [
    {
      name: 'stream',
      mode: RpcMode.ServerStream,
      async *handle() {
        yield Buffer.of(7)
        yield Buffer.of(8)
      },
    },
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
  ])
  const controller = new AbortController()
  /** @type {string[]} */
  const notifications = []
  const stream = peer.stream('stream', {
    signal: controller.signal,
    onResponse() {
      notifications.push('response')
      controller.abort()
    },
    onFailure(failure) { notifications.push(failure.error.code) },
  })
  assert.deepEqual(await stream.next(), { value: Buffer.of(7), done: false })
  await assert.rejects(stream.next(), { code: 'CANCELLED' })
  assert.deepEqual(notifications, ['response', 'CANCELLED'])
  assert.deepEqual(await peer.request('echo', Buffer.of(9)), Buffer.of(9))
})

test('terminal observers run before upload abort listeners can reenter RPC', { timeout: 5_000 }, async t => {
  const { peer } = await connect(t, [{
    name: 'upload',
    mode: RpcMode.ClientStream,
    async handle({ data, input }) {
      await input[Symbol.asyncIterator]().next()
      if (data[0]) throw new RpcError('UNAVAILABLE')
      return Buffer.of(9)
    },
  }])

  for (const shouldFail of [false, true]) {
    /** @type {string[]} */
    const order = []
    const result = peer.request('upload', Buffer.of(Number(shouldFail)), {
      async *input(signal) {
        signal.addEventListener('abort', () => { order.push('upload abort') }, { once: true })
        yield Buffer.of(1)
        if (!signal.aborted) await once(signal, 'abort')
      },
      onResponse() { order.push('response') },
      onFailure() { order.push('failure') },
    })
    if (shouldFail) await assert.rejects(result, { code: 'UNAVAILABLE' })
    else assert.deepEqual(await result, Buffer.of(9))
    assert.deepEqual(order, [shouldFail ? 'failure' : 'response', 'upload abort'])
  }
})
