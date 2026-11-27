import assert from 'node:assert/strict'
import { once } from 'node:events'
import { get } from 'node:http'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { Context } from '@deepseek-ai/cordis'

const host = '127.0.0.1'

/** @param {number} port @param {string} path @param {number} [timeoutMs] */
function upgrade(port, path, timeoutMs = 4_000) {
  /** @type {Promise<{ status: number | undefined, socket?: import('node:stream').Duplex }>} */
  const response = new Promise((resolve, reject) => {
    get({
      host, port, path,
      headers: { connection: 'Upgrade', upgrade: 'probe' },
      signal: AbortSignal.timeout(timeoutMs),
    })
      .once('error', reject)
      .once('response', (reply) => {
        reply.resume()
        resolve({ status: reply.statusCode })
      })
      .once('upgrade', (reply, socket) => resolve({ status: reply.statusCode, socket }))
  })
  return response
}

test('dispatches upgrades once and gives the registered protocol time to drain', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  const fallback = t.mock.fn()
  const owner = await app.plugin({
    inject: ['http'],
    apply(ctx) {
      ctx.http.registerUpgrade(({ request, socket, signal }) => {
        if (request.url !== '/claimed') return false
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: probe\r\n\r\n')
        signal.addEventListener('abort', () => {
          socket.write('drain')
          socket.once('data', () => socket.end())
        }, { once: true })
        return true
      })
    },
  }).await()
  const listener = await app.plugin(httpListener, {
    host,
    port: 0,
    shutdownTimeoutMs: 1000,
    prepare(_server, handle) {
      return {
        handle,
        onUpgrade({ request, socket }) {
          fallback(request.url)
          if (request.url !== '/fallback') return false
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
          return true
        },
      }
    },
  }).await()
  const address = app.http.address()
  assert.ok(address)
  assert.equal((await upgrade(address.port, '/fallback')).status, 403)
  assert.equal((await upgrade(address.port, '/missing')).status, 404)
  const { status, socket } = await upgrade(address.port, '/claimed')
  assert.equal(status, 101)
  assert.ok(socket)
  t.after(() => { socket.destroy() })
  assert.equal(fallback.mock.callCount(), 2)

  const message = once(socket, 'data', { signal: AbortSignal.timeout(2_000) })
  const stopped = listener.dispose()
  assert.equal(String((await message)[0]), 'drain')
  socket.write('ack')
  await stopped
  await owner.dispose()
  assert.equal(app.http.address(), null)
})

test('dispatch skips revoked upgrade handlers and defers new registrations', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  let added = false
  app.http.registerUpgrade(() => {
    if (!added) {
      added = true
      void revoke()
      app.http.registerUpgrade(({ socket }) => {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return true
      })
    }
    return false
  })
  const revoke = app.http.registerUpgrade(({ socket }) => {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    return true
  })
  await app.plugin(httpListener, { host, port: 0 }).await()
  const address = app.http.address()
  assert.ok(address)
  assert.equal((await upgrade(address.port, '/probe')).status, 404)
  assert.equal((await upgrade(address.port, '/probe')).status, 403)
})

test('keeps native and managed upgrade listeners exclusive during registration', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  const unmount = app.http.registerUpgrade(() => false)
  /** @type {import('node:http').Server | undefined} */
  let preparedServer
  await app.plugin(httpListener, {
    host, port: 0,
    prepare(server, handle) {
      preparedServer = server
      return { handle }
    },
  }).await()
  const server = preparedServer
  const address = app.http.address()
  assert.ok(server)
  assert.ok(address)
  /** @type {(request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex) => void} */
  const nativeUpgrade = (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  }

  assert.throws(() => server.on('upgrade', nativeUpgrade), /require exclusive dispatch/)
  assert.equal((await upgrade(address.port, '/probe')).status, 404)
  await unmount()
  server.on('upgrade', nativeUpgrade)
  assert.throws(() => app.http.registerUpgrade(() => false), /require exclusive dispatch/)
  assert.equal((await upgrade(address.port, '/probe')).status, 403)

  server.off('upgrade', nativeUpgrade)
  server.once('newListener', (event) => {
    if (event === 'upgrade') server.on('upgrade', nativeUpgrade)
  })
  assert.throws(() => app.http.registerUpgrade(() => false), /require exclusive dispatch/)
  app.http.registerUpgrade(() => false)
  assert.equal((await upgrade(address.port, '/probe')).status, 404)
})

test('invalid asynchronous upgrade claims fail closed for both handler kinds', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  /** @param {import('@ainess/http').HttpUpgrade} upgrade */
  async function misconfigured({ request }) {
    if (request.url === '/fallback') throw new Error('Invalid asynchronous fallback')
    return false
  }
  const invalid = /** @type {import('@ainess/http').HttpUpgradeHandler} */ (/** @type {unknown} */ (misconfigured))
  const startLazyClaim = t.mock.fn()
  const lazy = /** @type {import('@ainess/http').HttpUpgradeHandler} */ (/** @type {unknown} */ (
    () => ({ then() { startLazyClaim() } })
  ))
  app.http.registerUpgrade(upgrade => {
    if (upgrade.request.url === '/registered') return invalid(upgrade)
    return upgrade.request.url === '/lazy' ? lazy(upgrade) : false
  })
  await app.plugin(httpListener, {
    host, port: 0, shutdownTimeoutMs: 100,
    prepare: (_server, handle) => ({ handle, onUpgrade: invalid }),
  }).await()
  const address = app.http.address()
  assert.ok(address)
  await Promise.all([
    assert.rejects(upgrade(address.port, '/registered', 1_500), { code: 'ECONNRESET' }),
    assert.rejects(upgrade(address.port, '/fallback', 1_500), { code: 'ECONNRESET' }),
    assert.rejects(upgrade(address.port, '/lazy', 1_500), { code: 'ECONNRESET' }),
  ])
  assert.equal(startLazyClaim.mock.callCount(), 0)
})
