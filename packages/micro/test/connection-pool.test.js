import assert from 'node:assert/strict'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'
import test from 'node:test'
import { setImmediate as yieldToIO } from 'node:timers/promises'
import { createMicroClient } from '@ainess/micro'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'
import { deferred } from '../../rpc/dist/deferred.js'
import { MessageModem } from '../../rpc/dist/modem.js'
import { MAX_CALL_ID } from '../../rpc/dist/wire.js'

/** @type {import('@ainess/rpc').RpcMethod} */
const echo = { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data }

/**
 * @param {import('node:test').TestContext} t
 * @param {readonly import('@ainess/rpc').RpcMethod[]} [methods]
 */
async function startServer(t, methods = [echo]) {
  /** @type {RpcPeer[]} */
  const peers = []
  const server = await RpcServer.listen({
    host: '127.0.0.1', port: 0, methods,
    onPeer(peer) { peers.push(peer) },
  })
  t.after(() => server.close())
  return { address: server.address, peers }
}

/** @param {import('node:test').TestContext} t */
function useLastDialerCallId(t) {
  const nextCallId = Object.getOwnPropertyDescriptor(MessageModem.prototype, 'nextCallId')?.get
  assert.ok(nextCallId)
  return t.mock.getter(MessageModem.prototype, 'nextCallId', /** @this {MessageModem} */ function () {
    const next = nextCallId.call(this)
    return next === 1 ? MAX_CALL_ID : next
  })
}

test('keeps acquiring connections across more than 256 discovered addresses', { timeout: 10_000 }, async t => {
  const server = await startServer(t)
  const peer = await RpcPeer.connect(server.address)
  // Reuse the test transport so the logical address fan-out fits typical file descriptor budgets.
  const dial = t.mock.method(RpcPeer, 'connect', async () => peer)
  const client = createMicroClient({
    discovery: { async pick({ service }) { return { ...server.address, host: service + '.test' } } },
  })
  t.after(async () => {
    await client.close()
    await peer.close()
  })

  const services = Array.from({ length: 260 }, (_, index) => `service-${index}`)
  const replies = await Promise.all(services.map(service =>
    client.request(service, 'echo', Buffer.from(service)).then(String),
  ))
  assert.deepEqual(replies, services)
  assert.equal(dial.mock.callCount(), services.length)
})

test('a single address can replace exhausted peers while their calls finish', { timeout: 5_000 }, async t => {
  const release = deferred()
  const payloads = Array.from({ length: 4 }, (_, index) => Buffer.of(index))
  const entered = payloads.map(() => deferred())
  t.after(() => release.resolve(undefined))
  const server = await startServer(t, [{
    name: 'hold', mode: RpcMode.Unary,
    async handle({ data }) {
      entered[data[0]].resolve(undefined)
      await release.promise
      return data
    },
  }])
  useLastDialerCallId(t)
  const client = createMicroClient({ discovery: { async pick() { return server.address } } })
  t.after(() => client.close())

  const requests = []
  try {
    for (const [index, data] of payloads.entries()) {
      const request = client.request('orders', 'hold', data)
      requests.push(request)
      void request.catch(() => {})
      await Promise.race([entered[index].promise, request])
    }
    assert.equal(server.peers.length, payloads.length)
  } finally {
    release.resolve(undefined)
  }
  assert.deepEqual(await Promise.all(requests), payloads)
})

test('replaces connections during native close and still waits for them at shutdown', { timeout: 5_000 }, async t => {
  const server = await startServer(t)
  const allowClose = [deferred(), deferred()]
  const closing = allowClose.map(() => deferred())
  const nativeClosed = allowClose.map(() => deferred())
  let sockets = 0
  const createConnection = net.createConnection
  const dial = t.mock.method(net, 'createConnection', (/** @type {import('node:net').NetConnectOpts} */ options) => {
    const socket = createConnection(options)
    if ('port' in options && options.port === server.address.port) {
      const index = sockets++
      if (index < allowClose.length) {
        const destroy = socket.destroy.bind(socket)
        t.mock.method(socket, 'destroy', (/** @type {Error | undefined} */ error) => {
          closing[index].resolve(undefined)
          void allowClose[index].promise.then(() => { destroy(error) })
          return socket
        })
        socket.once('close', () => nativeClosed[index].resolve(undefined))
      }
    }
    return socket
  })
  syncBuiltinESMExports()
  t.after(() => {
    for (const gate of allowClose) gate.resolve(undefined)
    dial.mock.restore()
    syncBuiltinESMExports()
  })
  const lastId = useLastDialerCallId(t)
  const client = createMicroClient({ discovery: { async pick() { return server.address } } })
  t.after(() => client.close())

  for (const [index, socketClosing] of closing.entries()) {
    const input = Buffer.of(index)
    assert.deepEqual(await client.request('orders', 'echo', input), input)
    await socketClosing.promise
  }
  lastId.mock.restore()
  assert.deepEqual(await client.request('orders', 'echo', Buffer.of(7), { timeoutMs: 1_000 }), Buffer.of(7))
  assert.equal(sockets, 3)

  const shutdown = client.close()
  assert.equal(await Promise.race([shutdown.then(() => true), yieldToIO(false)]), false)
  for (const gate of allowClose) gate.resolve(undefined)
  await shutdown
  for (const closed of nativeClosed) {
    assert.equal(await Promise.race([closed.promise.then(() => true), yieldToIO(false)]), true)
  }
})
