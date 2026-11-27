import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { websocket, websocketListener } from '@ainess/websocket'
import { connectWebSocket } from '@ainess/websocket-client'

const host = '127.0.0.1'

test('a client reconnects to the same port after a listener restart', { timeout: 7_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const received = t.mock.fn()
  app.websocket.route('/echo', {
    onMessage(connection, message) {
      received(message)
      return connection.send(message)
    },
  })
  const listener = await app.plugin(websocketListener, { host, port: 0 }).await()
  const address = app.websocket.address()
  assert.ok(address)
  const events = new EventEmitter()
  const signal = AbortSignal.timeout(4_000)
  const opened = once(events, 'open', { signal })
  const client = connectWebSocket(`ws://${host}:${address.port}/echo`, {
    initialDelayMs: 20,
    maxDelayMs: 100,
    onOpen: () => { events.emit('open') },
    onClose({ code }) { events.emit(`close:${code}`) },
    onMessage: (message) => { events.emit('message', message) },
  })
  t.after(() => client.close())
  await opened
  const before = once(events, 'message', { signal })
  client.send('before restart')
  assert.equal((await before)[0], 'before restart')

  const shutdown = once(events, 'close:1001', { signal })
  const offline = once(events, 'close:1006', { signal })
  const reconnected = once(events, 'open', { signal })
  await listener.dispose()
  await shutdown
  await offline
  assert.throws(() => client.send('while offline'), /not open/i)
  await app.plugin(websocketListener, { host, port: address.port }).await()
  await reconnected

  const reply = once(events, 'message', { signal })
  client.send(Uint8Array.of(1, 2, 255))
  assert.deepEqual((await reply)[0], Uint8Array.of(1, 2, 255))
  assert.equal(received.mock.callCount(), 2)
  const stopped = once(events, 'close:1000', { signal })
  client.close()
  await stopped
  await delay(100)
  assert.equal(client.readyState, WebSocket.CLOSED)
})
