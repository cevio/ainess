import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import test from 'node:test'
import { RpcMode, RpcServer } from '@ainess/rpc'
import { frame, openFrame } from '../dist/messages.js'
import { MessageModem } from '../dist/modem.js'
import { encodeHeader, encodeHello, FrameType, HEADER_SIZE, MAX_BODY, writeUint32 } from '../dist/wire.js'

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
 * @param {number} [maxIncomingCalls]
 */
async function startModem(t, role = 'acceptor', afterHello = [], maxIncomingCalls) {
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
  }, () => {}, () => { events.push('ready') }, maxIncomingCalls)
  t.after(async () => {
    peer.destroy()
    await modem.close()
    await new Promise(resolve => listener.close(() => resolve(undefined)))
  })

  const hello = encodeHello()
  hello.writeUInt32BE(fullWindow, 6)
  hello.writeUInt32BE(fullWindow, 10)
  hello.writeUInt32BE(fullWindow, 14)
  send(peer, frame(FrameType.Hello, 0, hello), ...afterHello)
  await modem.ready
  return { modem, peer, socket, marker, events }
}

test('a low call limit still allows a burst of control frames during socket backpressure', { timeout: 5_000 }, async t => {
  const { modem, socket } = await startModem(t, 'acceptor', [], 1)
  modem.open(1, true)
  socket.cork()
  const data = modem.send(frame(FrameType.Data, 1, Buffer.alloc(MAX_BODY)))
  const backpressured = socket.writableNeedDrain
  const controls = Array.from({ length: 8 }, (_, index) => modem.send(frame(FrameType.Cancel, 2 + index * 2)))
  socket.uncork()

  assert.equal(backpressured, true)
  await Promise.all([data, ...controls])
  assert.equal(modem.failure, undefined)
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
