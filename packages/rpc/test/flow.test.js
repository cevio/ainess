import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer, Socket } from 'node:net'
import test from 'node:test'
import { RpcError, RpcMode, RpcPeer, RpcServer, rpcPayloadLimit } from '@ainess/rpc'
import { deferred } from '../dist/deferred.js'
import { frame, openFrame } from '../dist/messages.js'
import { MessageModem } from '../dist/modem.js'
import { encodeHeader, encodeHello, FrameDecoder, FrameType, HEADER_SIZE, MAX_BODY, writeUint32 } from '../dist/wire.js'

/**
 * @param {import('node:net').Socket} socket
 * @param {...import('../dist/wire.js').Frame} frames
 */
function send(socket, ...frames) {
  socket.write(Buffer.concat(frames.flatMap(value => [encodeHeader(value), value.body])))
}

const fullWindow = HEADER_SIZE + MAX_BODY

/**
 * @param {import('node:test').TestContext} t
 * @param {'dialer' | 'acceptor'} [role]
 * @param {import('../dist/wire.js').Frame[]} [afterHello]
 * @param {number} [streamWindow]
 */
async function startModem(t, role = 'acceptor', afterHello = [], streamWindow = fullWindow) {
  const listener = createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')

  const accepted = once(listener, 'connection')
  const peer = createConnection({ host: '127.0.0.1', port: address.port })
  peer.on('error', () => {})
  peer.resume()
  const [socket] = await accepted

  /** @type {() => void} */
  let seenMarker = () => {}
  const marker = new Promise(resolve => { seenMarker = () => resolve(undefined) })
  /** @type {string[]} */
  const events = []
  const modem = new MessageModem(socket, role, value => {
    if (value.type === FrameType.Open) events.push('open')
    if (value.type === FrameType.Open || value.type === FrameType.StopInput) seenMarker()
  }, () => {}, () => { events.push('ready') })
  t.after(async () => {
    peer.destroy()
    await modem.close()
    await new Promise(resolve => listener.close(() => resolve(undefined)))
  })

  const hello = encodeHello()
  hello.writeUInt32BE(fullWindow, 4)
  hello.writeUInt32BE(streamWindow, 8)
  hello.writeUInt32BE(fullWindow, 12)
  send(peer, frame(FrameType.Hello, 0, hello), ...afterHello)
  await modem.ready
  return { modem, peer, socket, marker, events }
}

test('drains more than 4096 queued control frames during socket backpressure', { timeout: 5_000 }, async t => {
  const { modem, socket } = await startModem(t)
  modem.open(1, true)
  socket.cork()
  const data = modem.send(frame(FrameType.Data, 1, Buffer.alloc(MAX_BODY)))
  const backpressured = socket.writableNeedDrain
  const controls = Array.from({ length: 4_608 }, (_, index) => modem.send(frame(FrameType.Cancel, 2 + index * 2)))
  socket.uncork()

  assert.equal(backpressured, true)
  await Promise.all([data, ...controls])
  assert.equal(modem.failure, undefined)
})

test('retiring a call drops all its queued controls and preserves the order of the others', {
  timeout: 5_000,
}, async t => {
  const { modem, socket } = await startModem(t)
  modem.open(1, true)
  socket.cork()
  const data = modem.send(frame(FrameType.Data, 1, Buffer.alloc(MAX_BODY)))
  const backpressured = socket.writableNeedDrain
  /** @type {number[]} */
  const written = []
  const controls = [
    frame(FrameType.StopInput, 2),
    frame(FrameType.Cancel, 4),
    frame(FrameType.End, 2),
    frame(FrameType.StopInput, 6),
    frame(FrameType.End, 6),
  ]
  const results = Promise.allSettled(controls.map((value, index) => modem.send(value, () => { written.push(index) })))
  modem.retire(2)
  socket.uncork()

  assert.equal(backpressured, true)
  await data
  const outcomes = await results
  assert.deepEqual(written, [1, 3, 4])
  assert.deepEqual(outcomes.map(outcome => outcome.status === 'rejected' ? outcome.reason.code : outcome.status),
    ['CANCELLED', 'fulfilled', 'CANCELLED', 'fulfilled', 'fulfilled'])
})

test('the RPC call timeout drops an OPEN still queued under backpressure', { timeout: 5_000 }, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  /** @type {string[]} */
  const executions = []
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [{
      name: 'echo',
      mode: RpcMode.Unary,
      handle({ data }) {
        executions.push(Buffer.from(data).toString())
        return data
      },
    }],
  })
  t.after(() => server.close())

  /** @type {Socket | undefined} */
  let dialer
  const keepAlive = Socket.prototype.setKeepAlive
  /** @this {Socket} @param {boolean} [enable] @param {number} [idle] */
  function holdAfterHello(enable, idle) {
    if (this.remotePort === server.address.port) {
      dialer = this
      const write = this.write
      t.mock.method(this, 'write', (/** @type {Uint8Array} */ bytes) => {
        const written = write.call(this, bytes)
        return bytes[8] === FrameType.Hello ? false : written
      })
    }
    return keepAlive.call(this, enable, idle)
  }
  t.mock.method(Socket.prototype, 'setKeepAlive', holdAfterHello)
  const peer = await RpcPeer.connect(server.address)
  t.after(() => peer.close())
  assert.ok(dialer)

  /** @type {import('@ainess/rpc').RpcCallFailure[]} */
  const failures = []
  const expired = peer.request('echo', Buffer.from('expired'), {
    timeoutMs: 250,
    onFailure(failure) { failures.push(failure) },
  })
  const next = peer.request('echo', Buffer.from('next'))
  const results = Promise.allSettled([expired, next])
  now += 300
  dialer.emit('drain')

  const [deadline, response] = await results
  assert.deepEqual(executions, ['next'])
  assert.equal(deadline.status, 'rejected')
  assert.equal(deadline.reason.code, 'DEADLINE_EXCEEDED')
  assert.deepEqual(failures.map(({ source, sentAt }) => [source, sentAt]), [['local', undefined]])
  assert.deepEqual(response, { status: 'fulfilled', value: Buffer.from('next') })
})

test('a queued OPEN preserves a local upload error without reading its code', { timeout: 5_000 }, async t => {
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [
      { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
      {
        name: 'upload',
        mode: RpcMode.ClientStream,
        async handle({ input }) {
          for await (const chunk of input) void chunk
          return Buffer.alloc(0)
        },
      },
    ],
  })
  t.after(() => server.close())

  /** @type {Socket | undefined} */
  let dialer
  const keepAlive = Socket.prototype.setKeepAlive
  /** @this {Socket} @param {boolean} [enable] @param {number} [idle] */
  function captureDialer(enable, idle) {
    if (this.remotePort === server.address.port) dialer = this
    return keepAlive.call(this, enable, idle)
  }
  t.mock.method(Socket.prototype, 'setKeepAlive', captureDialer)
  const peer = await RpcPeer.connect(server.address)
  t.after(() => peer.close())
  assert.ok(dialer)

  const uploadError = Object.defineProperty(new RpcError('INTERNAL', 'upload failed'), 'code', {
    get() { throw new Error('unreadable upload error code') },
  })
  /** @type {import('@ainess/rpc').RpcCallFailure[]} */
  const failures = []
  const fullPayload = Buffer.alloc(rpcPayloadLimit('echo'))
  dialer.cork()
  const replies = Array.from({ length: 4 }, () => peer.request('echo', fullPayload))
  assert.equal(dialer.writableNeedDrain, true)
  const upload = peer.request('upload', {
    input() { throw uploadError },
    onFailure(failure) { failures.push(failure) },
    timeoutMs: 1_000,
  })
  dialer.uncork()

  await assert.rejects(upload, error => error === uploadError)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].source, 'local')
  assert.equal(typeof failures[0].sentAt, 'number')
  await Promise.all(replies)
  assert.deepEqual(await peer.request('echo', Buffer.from('next')), Buffer.from('next'))
})

test('cancelling a rejected call discards its queued error under socket backpressure', {
  timeout: 5_000,
}, async t => {
  const handled = deferred()
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [{
      name: 'known', mode: RpcMode.Unary,
      handle() {
        handled.resolve(undefined)
        return Buffer.alloc(0)
      },
    }],
  })
  t.after(() => server.close())
  const address = server.address
  /** @type {Socket | undefined} */
  let accepted
  const keepAlive = Socket.prototype.setKeepAlive
  /** @this {Socket} @param {boolean} [enable] @param {number} [idle] */
  function captureSocket(enable, idle) {
    if (this.localPort === address.port) {
      accepted = this
      const write = this.write
      // Hold the modem in backpressure after it submits HELLO, until the test releases it.
      t.mock.method(this, 'write', (/** @type {Uint8Array} */ bytes) => {
        const written = write.call(this, bytes)
        return bytes[8] === FrameType.Hello ? false : written
      })
    }
    return keepAlive.call(this, enable, idle)
  }
  t.mock.method(Socket.prototype, 'setKeepAlive', captureSocket)

  const peer = createConnection(address)
  t.after(() => { peer.destroy() })
  const decoder = new FrameDecoder()
  const replied = deferred()
  /** @type {number[]} */
  const errors = []
  peer.on('data', chunk => decoder.push(Buffer.from(chunk), ({ type, id }) => {
    if (type === FrameType.Error) errors.push(id)
    if (type === FrameType.End && id === 3) replied.resolve(undefined)
  }))
  send(peer, frame(FrameType.Hello, 0, encodeHello()),
    openFrame(1, 'missing', Buffer.alloc(0)), frame(FrameType.Cancel, 1), openFrame(3, 'known', Buffer.alloc(0)))
  await handled.promise
  assert.ok(accepted)
  accepted.emit('drain')
  await replied.promise
  assert.deepEqual(errors, [])
})

test('the minimum stream window admits a full upload and any usable reserve admits a reply', { timeout: 5_000 }, async t => {
  for (const role of /** @type {const} */ (['dialer', 'acceptor'])) {
    for (const extra of [0, HEADER_SIZE - 1, HEADER_SIZE]) {
      const { modem, peer, socket } = await startModem(t, role, [], fullWindow + extra)
      const first = role === 'dialer' ? 1 : 2
      const reply = role === 'dialer' ? 2 : 1
      modem.open(first, true)
      modem.open(first + 2, true)
      modem.open(reply, true)

      await modem.send(frame(FrameType.Data, first, Buffer.alloc(MAX_BODY)))
      if (socket.writableNeedDrain) await once(socket, 'drain')

      /** @type {string[]} */
      const written = []
      const upload = modem.send(frame(FrameType.Data, first + 2), () => { written.push('upload') })
      void upload.catch(() => {})
      assert.equal(written.length, 0)

      const response = modem.send(frame(FrameType.Data, reply), () => { written.push('reply') })
      void response.catch(() => {})

      const canReply = extra === HEADER_SIZE
      if (canReply) await response
      assert.deepEqual(written, canReply ? ['reply'] : [])

      send(peer, frame(FrameType.WindowUpdate, 0, writeUint32(fullWindow), 1))
      await Promise.all([upload, response])
      assert.deepEqual(written, canReply ? ['reply', 'upload'] : ['upload', 'reply'])
    }
  }
})

test('shared DATA credit accumulates for the oldest stream with available call credit', { timeout: 5_000 }, async t => {
  const { modem, peer, socket, marker } = await startModem(t)
  modem.open(1, true)
  modem.open(3, true)
  modem.open(5, true)
  const largeBody = Buffer.alloc(MAX_BODY)
  await modem.send(frame(FrameType.Data, 1, largeBody))
  if (socket.writableNeedDrain) await once(socket, 'drain')

  /** @type {number[]} */
  const written = []
  const older = modem.send(frame(FrameType.Data, 3, largeBody), () => { written.push(3) })
  const newer = modem.send(frame(FrameType.Data, 5, Buffer.of(0)), () => { written.push(5) })
  void older.catch(() => {})
  void newer.catch(() => {})

  const smallCredit = HEADER_SIZE + 1
  send(peer, frame(FrameType.WindowUpdate, 0, writeUint32(smallCredit), 1), frame(FrameType.StopInput, 5))
  await marker
  // The marker follows the credit update on TCP and the modem flushes before leaving that read.
  assert.deepEqual(written, [])

  send(peer, frame(FrameType.WindowUpdate, 0, writeUint32(fullWindow - smallCredit), 1))
  await older
  assert.deepEqual(written, [3])

  send(peer, frame(FrameType.WindowUpdate, 0, writeUint32(smallCredit), 1))
  await newer
  assert.deepEqual(written, [3, 5])
})

test('queueing DATA without credit waits for a window update before scheduling writes', { timeout: 5_000 }, async t => {
  const { modem, peer, socket } = await startModem(t)
  modem.open(2, true)
  await modem.send(frame(FrameType.Data, 2, Buffer.alloc(MAX_BODY)))
  if (socket.writableNeedDrain) await once(socket, 'drain')

  const cork = t.mock.method(socket, 'cork')
  /** @type {number[]} */
  const written = []
  const ids = Array.from({ length: 64 }, (_, index) => 4 + index * 2)
  const pending = Promise.all(ids.map(id => {
    modem.open(id, true)
    return modem.send(frame(FrameType.Data, id), () => { written.push(id) })
  }))
  void pending.catch(() => {})
  assert.equal(cork.mock.callCount(), 0)
  assert.deepEqual(written, [])

  send(peer, frame(FrameType.WindowUpdate, 0, writeUint32(ids.length * HEADER_SIZE), 1))
  await pending
  assert.deepEqual(written, ids)
})

test('a blocked upload holds later uploads while a reply can pass', { timeout: 5_000 }, async t => {
  const { modem, peer, socket, marker } = await startModem(t, 'acceptor', [], 2 * fullWindow)
  modem.open(2, true)
  modem.open(4, true)
  modem.open(1, true)
  await modem.send(frame(FrameType.Data, 2, Buffer.alloc(MAX_BODY)))
  if (socket.writableNeedDrain) await once(socket, 'drain')

  const older = modem.send(frame(FrameType.Data, 4, Buffer.alloc(MAX_BODY)))
  void older.catch(() => {})
  const ids = Array.from({ length: 64 }, (_, index) => 6 + index * 2)
  const credit = (ids.length + 1) * HEADER_SIZE
  send(peer, frame(FrameType.WindowUpdate, 0, writeUint32(credit), 1), frame(FrameType.StopInput, 4))
  await marker

  const cork = t.mock.method(socket, 'cork')
  /** @type {number[]} */
  const written = []
  const pending = Promise.all(ids.map(id => {
    modem.open(id, true)
    return modem.send(frame(FrameType.Data, id), () => { written.push(id) })
  }))
  void pending.catch(() => {})
  assert.equal(cork.mock.callCount(), 0)
  assert.equal(written.length, 0)

  await modem.send(frame(FrameType.Data, 1), () => { written.push(1) })
  assert.deepEqual(written, [1])
  modem.retire(4)
  await assert.rejects(older, { code: 'CANCELLED' })
  await pending
  assert.deepEqual(written, [1, ...ids])
})

test('retiring a blocked unsent OPEN wakes the next eligible OPEN', { timeout: 5_000 }, async t => {
  const { modem, peer, socket, marker } = await startModem(t)
  modem.open(2, false)
  modem.open(4, false)
  modem.open(6, false)
  const largeBody = Buffer.alloc(MAX_BODY)
  const smallBody = Buffer.of(1, 0x78) // One-byte method name 'x'.
  smallBody.copy(largeBody)
  await modem.send(frame(FrameType.Open, 2, largeBody))
  if (socket.writableNeedDrain) await once(socket, 'drain')

  let written = false
  const older = modem.send(frame(FrameType.Open, 4, largeBody))
  const newer = modem.send(frame(FrameType.Open, 6, smallBody), () => { written = true })
  void older.catch(() => {})
  void newer.catch(() => {})

  const smallCredit = HEADER_SIZE + smallBody.length
  send(peer, frame(FrameType.WindowUpdate, 0, writeUint32(smallCredit)), frame(FrameType.StopInput, 2))
  await marker
  assert.equal(written, false)

  modem.retire(4)
  await assert.rejects(older, { code: 'CANCELLED' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(written, true)
  await newer
})

test('dialer and acceptor advance separate call ID ranges on one connection', { timeout: 5_000 }, async t => {
  for (const role of /** @type {const} */ (['dialer', 'acceptor'])) {
    const { modem } = await startModem(t, role)
    const local = role === 'dialer' ? 1 : 2
    const remote = role === 'dialer' ? 10 : 9
    assert.equal(modem.nextCallId, local)
    assert.equal(modem.isLocal(0), false)
    assert.equal(modem.isLocal(local), true)
    assert.equal(modem.isLocal(remote), false)

    modem.open(remote, true)
    modem.open(local, true)
    assert.equal(modem.lastOpened(remote + 2), remote)
    assert.equal(modem.lastOpened(local + 2), local)
    assert.equal(modem.nextCallId, local + 2)
    assert.throws(() => modem.open(remote, true), /call IDs must increase/)
  }
})

test('synchronous HELLO readiness runs before a following OPEN', { timeout: 5_000 }, async t => {
  const { marker, events } = await startModem(t, 'acceptor', [frame(FrameType.Open, 1, Buffer.of(1, 0x78))])
  await marker
  assert.deepEqual(events, ['ready', 'open'])
})

test('closing from onPeer prevents a following OPEN in the same TCP write', { timeout: 5_000 }, async t => {
  let handled = false
  /** @type {Promise<void> | undefined} */
  let closing
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    onPeer() { closing = server.close() },
    methods: [{
      name: 'probe',
      mode: RpcMode.Unary,
      handle() {
        handled = true
        return new Uint8Array()
      },
    }],
  })
  t.after(() => server.close())

  const peer = createConnection(server.address)
  t.after(() => { peer.destroy() })
  peer.on('error', () => {})
  peer.resume()
  const closed = new Promise(resolve => { peer.once('close', resolve) })
  send(peer, frame(FrameType.Hello, 0, encodeHello()), openFrame(1, 'probe', new Uint8Array()))

  await closed
  assert.ok(closing)
  await closing
  assert.equal(handled, false)
})
