import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connectWebSocket } from '@ainess/websocket-client'

const host = '127.0.0.1'

test('honors cancellation when the URL is converted before the first dial', async (t) => {
  const server = createServer((_request, response) => response.writeHead(503).end()).listen(0, host)
  /** @type {import('@ainess/websocket-client').WebSocketClient | undefined} */
  let client
  t.after(() => {
    client?.close()
    return new Promise((resolve) => server.close(resolve))
  })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const controller = new AbortController()
  const reason = new Error('Connection cancelled during URL conversion')
  const url = new URL(`ws://${host}:${address.port}/`)
  url.toString = () => {
    controller.abort(reason)
    return url.href
  }

  assert.throws(() => {
    client = connectWebSocket(url, { signal: controller.signal, maxAttempts: 0 })
  }, error => error === reason)
})

test('limits failed retries and cancels a pending retry when aborted', { timeout: 7_000 }, async (t) => {
  const request = t.mock.fn()
  const server = createServer((_request, response) => {
    request()
    response.writeHead(503).end()
  }).listen(0, host)
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `ws://${host}:${address.port}/`
  const events = new EventEmitter()
  const signal = AbortSignal.timeout(4_000)
  const exhausted = once(events, 'exhausted', { signal })
  let failures = 0
  const selectProtocols = t.mock.fn(() => ['test'])
  const selectAttempts = t.mock.fn(() => 2)
  const client = connectWebSocket(url, {
    initialDelayMs: 15,
    maxDelayMs: 50,
    get protocols() { return selectProtocols() },
    get maxAttempts() { return selectAttempts() },
    onClose(close) {
      if (++failures === 3) events.emit('exhausted', close.code)
    },
  })
  t.after(() => client.close())
  assert.equal((await exhausted)[0], 1006)
  assert.equal(client.readyState, WebSocket.CLOSED)
  assert.equal(request.mock.callCount(), 3)
  assert.equal(selectProtocols.mock.callCount(), 1)
  assert.equal(selectAttempts.mock.callCount(), 1)

  const controller = new AbortController()
  const failed = once(events, 'failed', { signal })
  const aborted = connectWebSocket(url, {
    initialDelayMs: 50,
    signal: controller.signal,
    onClose() { events.emit('failed') },
  })
  t.after(() => aborted.close())
  await failed
  controller.abort()
  await delay(100)
  assert.equal(aborted.readyState, WebSocket.CLOSED)
  assert.equal(request.mock.callCount(), 4)
})

test('times out a pending handshake before retrying', { timeout: 7_000 }, async (t) => {
  const events = new EventEmitter()
  const sockets = /** @type {Set<import('node:stream').Duplex>} */ (new Set())
  const server = createServer().on('upgrade', (_request, socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    events.emit('upgrade')
  }).listen(0, host)
  t.after(() => {
    for (const socket of sockets) socket.destroy()
    return new Promise((resolve) => server.close(resolve))
  })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const signal = AbortSignal.timeout(4_000)
  const first = once(events, 'upgrade', { signal })
  const client = connectWebSocket(`ws://${host}:${address.port}/`, {
    initialDelayMs: 15,
    maxAttempts: 1,
    connectTimeoutMs: 200,
  })
  t.after(() => client.close())
  await first
  await once(events, 'upgrade', { signal })
  client.close()
})
