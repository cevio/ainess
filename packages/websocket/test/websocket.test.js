import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { get } from 'node:http'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { websocket, websocketListener } from '@ainess/websocket'
import { websocketHttp } from '@ainess/websocket/http'
import { Context } from '@deepseek-ai/cordis'
import WebSocket from 'ws'

const host = '127.0.0.1'

/**
 * @param {import('node:test').TestContext} t
 * @param {number} port
 * @param {string} path
 * @param {import('ws').ClientOptions} [options]
 */
async function connect(t, port, path, options) {
  const connection = new WebSocket(`ws://${host}:${port}${path}`, options)
  t.after(() => { connection.terminate() })
  connection.on('error', () => {})
  await once(connection, 'open', { signal: AbortSignal.timeout(4_000) })
  return connection
}

/** @param {WebSocket} connection @param {string | Buffer} message */
async function echo(connection, message) {
  const result = once(connection, 'message', { signal: AbortSignal.timeout(4_000) })
  connection.send(message)
  const [received, binary] = await result
  assert.equal(binary, typeof message !== 'string')
  assert.deepEqual(received, typeof message === 'string' ? Buffer.from(message) : message)
}

/** @param {number} port @param {string} path @param {string} [cookie] */
function upgradeStatus(port, path, cookie) {
  /** @type {Promise<number | undefined>} */
  const result = new Promise((resolve, reject) => {
    get({
      host, port, path,
      headers: {
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.alloc(16).toString('base64'),
        ...(cookie && { cookie }),
      },
      signal: AbortSignal.timeout(4_000),
    }, (response) => {
      response.resume()
      resolve(response.statusCode)
    }).once('error', reject).once('upgrade', (_response, socket) => {
      socket.destroy()
      reject(new Error('Unexpected accepted upgrade'))
    })
  })
  return result
}

test('one route serves standalone and mounted connections with separate listener ownership', {
  timeout: 8_000,
}, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await app.plugin(websocket).await()
  const mount = await app.plugin(websocketHttp).await()
  const onClose = t.mock.fn()
  const routes = await app.plugin({
    inject: ['http', 'websocket'],
    apply(ctx) {
      ctx.http.route('GET', '/ws/echo', (request) => { request.body = 'HTTP response' })
      ctx.websocket.route('/ws/echo', {
        onMessage: (connection, message) => connection.send(message),
        onClose(connection, info) {
          assert.equal(connection.signal.aborted, true)
          onClose(info.code)
        },
      })
    },
  }).await()
  const mounted = await app.plugin(httpListener, { host, port: 0 }).await()
  const mountedAddress = app.http.address()
  assert.ok(mountedAddress)
  const conflict = app.plugin(websocketListener, { host, port: mountedAddress.port })
  await assert.rejects(conflict.await(), { code: 'EADDRINUSE' })
  assert.equal(app.websocket.address(), null)
  const standalone = await app.plugin(websocketListener, { host, port: 0 }).await()
  const standaloneAddress = app.websocket.address()
  assert.ok(standaloneAddress)
  assert.equal(await (await fetch(`http://${host}:${mountedAddress.port}/ws/echo`)).text(), 'HTTP response')
  assert.equal(await (await fetch(`http://${host}:${standaloneAddress.port}/ws/echo`)).status, 404)
  assert.equal(await upgradeStatus(mountedAddress.port, '/missing'), 404)
  assert.equal(await upgradeStatus(standaloneAddress.port, '/missing'), 404)

  const shared = await connect(t, mountedAddress.port, '/ws/echo?mounted')
  const dedicated = await connect(t, standaloneAddress.port, '/ws/echo?standalone')
  await echo(shared, '你好')
  await echo(dedicated, Buffer.from([0, 1, 255]))

  const sharedClosed = once(shared, 'close', { signal: AbortSignal.timeout(3_000) })
  await mounted.dispose()
  assert.equal((await sharedClosed)[0], 1001)
  await echo(dedicated, 'still standalone')
  const remounted = await app.plugin(httpListener, { host, port: mountedAddress.port }).await()
  const secondShared = await connect(t, mountedAddress.port, '/ws/echo')
  const dedicatedClosed = once(dedicated, 'close', { signal: AbortSignal.timeout(3_000) })
  await standalone.dispose()
  assert.equal((await dedicatedClosed)[0], 1001)
  assert.equal(app.websocket.address(), null)
  await echo(secondShared, 'still mounted')
  const reused = await app.plugin(websocketListener, { host, port: standaloneAddress.port }).await()
  const secondDedicated = await connect(t, standaloneAddress.port, '/ws/echo')
  const secondDedicatedClosed = once(secondDedicated, 'close', { signal: AbortSignal.timeout(3_000) })
  const secondSharedClosed = once(secondShared, 'close', { signal: AbortSignal.timeout(3_000) })
  await routes.dispose()
  assert.equal((await secondSharedClosed)[0], 1001)
  assert.equal((await secondDedicatedClosed)[0], 1001)
  assert.deepEqual(onClose.mock.calls.map(({ arguments: args }) => args[0]), [1001, 1001, 1001, 1001])
  assert.equal(await upgradeStatus(mountedAddress.port, '/ws/echo'), 404)
  assert.equal(await upgradeStatus(standaloneAddress.port, '/ws/echo'), 404)
  await Promise.all([remounted.dispose(), reused.dispose()])
  await mount.dispose()
})

test('authorizes before 101 and cancels pending handshakes on route removal', { timeout: 7_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  const pending = once(events, 'pending', { signal: AbortSignal.timeout(4_000) })
  const release = () => { events.emit('release') }
  t.after(release)
  const onOpen = t.mock.fn()
  const routes = await app.plugin({
    inject: ['websocket'],
    apply(ctx) {
      ctx.websocket.route('/auth', {
        async authorize({ request, signal }) {
          if (request.headers.cookie !== 'session=pending') return { accept: false, status: 401 }
          const wait = once(events, 'release')
          events.emit('pending', signal)
          await wait
          return { accept: true, state: { user: 'demo' } }
        },
        onOpen,
      })
    },
  }).await()
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const address = app.websocket.address()
  assert.ok(address)
  assert.equal(await upgradeStatus(address.port, '/auth'), 401)
  const response = upgradeStatus(address.port, '/auth', 'session=pending')
  const [signal] = await pending
  await routes.dispose()
  assert.equal(await response, 503)
  assert.equal(signal.aborted, true)
  release()
  assert.equal(await upgradeStatus(address.port, '/auth'), 404)
  assert.equal(onOpen.mock.callCount(), 0)
})

test('disconnecting during asynchronous authorization cancels either listener promptly', {
  timeout: 7_000,
}, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await app.plugin(websocket, { handshakeTimeoutMs: 10_000 }).await()
  await app.plugin(websocketHttp).await()
  const events = new EventEmitter()
  const onOpen = t.mock.fn()
  app.websocket.route('/auth', {
    async authorize({ signal }) {
      const aborted = once(signal, 'abort')
      events.emit('pending', signal)
      await aborted
      return { accept: true, state: undefined }
    },
    onOpen,
  })
  await app.plugin(websocketListener, { host, port: 0 }).await()
  await app.plugin(httpListener, { host, port: 0 }).await()
  for (const [listener, address] of /** @type {const} */ ([
    ['standalone', app.websocket.address()],
    ['mounted', app.http.address()],
  ])) {
    await t.test(listener, async (t) => {
      assert.ok(address)
      const pending = once(events, 'pending', { signal: AbortSignal.timeout(2_000) })
      const client = new WebSocket(`ws://${host}:${address.port}/auth`)
      client.on('error', () => {})
      t.after(() => { client.terminate() })
      const [signal] = await pending
      const aborted = once(signal, 'abort', { signal: AbortSignal.timeout(1_500) })
      client.terminate()
      await aborted
    })
  }
  assert.equal(onOpen.mock.callCount(), 0)
})

test('passes authorized state and serializes message callbacks behind onOpen', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  const release = () => { events.emit('release') }
  t.after(release)
  const opened = once(events, 'opened', { signal: AbortSignal.timeout(4_000) })
  const onMessage = t.mock.fn()
  app.websocket.route('/state', {
    authorize: () => ({ accept: true, state: { user: 'demo' } }),
    async onOpen(connection) {
      assert.equal(connection.state.user, 'demo')
      const wait = once(events, 'release')
      events.emit('opened')
      await wait
    },
    async onMessage(connection, message) {
      onMessage(message)
      if (message === 'first') await new Promise((resolve) => setTimeout(resolve, 25))
      await connection.send(`${connection.state.user}:${message}`)
    },
  })
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const address = app.websocket.address()
  assert.ok(address)
  const connection = await connect(t, address.port, '/state')
  await opened
  /** @type {string[]} */
  const received = []
  const receivedTwo = new Promise((resolve) => {
    connection.on('message', (message) => {
      received.push(message.toString())
      if (received.length === 2) resolve(received)
    })
  })
  connection.send('first')
  connection.send('second')
  assert.equal(onMessage.mock.callCount(), 0)
  release()
  assert.deepEqual(await receivedTwo, ['demo:first', 'demo:second'])
})

test('bounds the handshake, received payload and local send queue', { timeout: 7_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket, { handshakeTimeoutMs: 50, maxPayload: 16, maxBufferedBytes: 16 }).await()
  const onOpen = t.mock.fn()
  const events = new EventEmitter()
  const timedOut = once(events, 'timeout', { signal: AbortSignal.timeout(4_000) })
  app.websocket.route('/timeout', {
    /** @returns {Promise<import('@ainess/websocket').WebSocketAuthorization<undefined>>} */
    authorize({ signal }) {
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          events.emit('timeout')
          resolve({ accept: true, state: undefined })
        }, { once: true })
      })
    },
    onOpen,
  })
  const oversizedSend = once(events, 'oversizedSend', { signal: AbortSignal.timeout(4_000) })
  app.websocket.route('/limits', {
    async onOpen(connection) {
      await assert.rejects(connection.send('1234567890123456'), /send buffer limit/i)
      events.emit('oversizedSend')
    },
  })
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const address = app.websocket.address()
  assert.ok(address)
  assert.equal(await upgradeStatus(address.port, '/timeout'), 408)
  await timedOut
  assert.equal(onOpen.mock.callCount(), 0)
  const connection = await connect(t, address.port, '/limits')
  await oversizedSend
  const closed = once(connection, 'close', { signal: AbortSignal.timeout(4_000) })
  connection.send(Buffer.alloc(17))
  assert.equal((await closed)[0], 1009)
})

test('closes a connection with a stalled receive queue or missed heartbeat', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket, { maxBufferedBytes: 16, heartbeatIntervalMs: 50 }).await()
  const onMessage = t.mock.fn()
  app.websocket.route('/stalled', {
    onOpen: ({ signal }) => once(signal, 'abort').then(() => {}),
    onMessage,
  })
  app.websocket.route('/heartbeat', {})
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const address = app.websocket.address()
  assert.ok(address)

  const slow = await connect(t, address.port, '/stalled')
  const overloaded = once(slow, 'close', { signal: AbortSignal.timeout(4_000) })
  slow.send(Buffer.alloc(9))
  slow.send(Buffer.alloc(9))
  assert.equal((await overloaded)[0], 1013)
  assert.equal(onMessage.mock.callCount(), 0)

  const unresponsive = await connect(t, address.port, '/heartbeat', { autoPong: false })
  const disconnected = once(unresponsive, 'close', { signal: AbortSignal.timeout(4_000) })
  assert.equal((await disconnected)[0], 1006)
})
