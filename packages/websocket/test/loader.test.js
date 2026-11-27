import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { websocket, websocketListener } from '@ainess/websocket'
import { websocketHttp } from '@ainess/websocket/http'
import { loadWebSocketRoutes, websocketRoutes } from '@ainess/websocket/loader'
import { connectWebSocketEndpoint } from '@ainess/websocket-client'
import { Context } from '@deepseek-ai/cordis'
import WebSocket from 'ws'

const host = '127.0.0.1'
const websocketModule = JSON.stringify(import.meta.resolve('@ainess/websocket'))

/** @param {import('node:test').TestContext} t @param {Record<string, string>} files */
async function fixtures(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-ws-loader-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [name, source] of Object.entries(files)) {
    const filename = join(directory, name)
    await mkdir(dirname(filename), { recursive: true })
    await writeFile(filename, source)
  }
  return directory
}

test('rejects empty service names and missing entries in Loader injection options', () => {
  for (const inject of [[''], new Array(1)]) {
    assert.throws(() => websocketRoutes({ directory: '.', inject }), /array of non-empty service names/)
  }
})

test('loads .ws modules, injects their services, and retires their routes on both listeners', {
  timeout: 8_000,
}, async (t) => {
  const directory = await fixtures(t, {
    '(internal)/echo/index.ws.mjs': `
      import { defineWebSocketEndpoint } from ${websocketModule}
      export default ctx => defineWebSocketEndpoint({ methods: { echo: { handle: () => ctx.get('message') } } })
    `,
    'ignored.socket.mjs': 'throw new Error("unexpected import")',
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  app.provide('message', 'through Cordis')
  await app.plugin(websocket).await()
  await app.plugin(http).await()
  await app.plugin(websocketHttp).await()
  const routes = await app.plugin(websocketRoutes({ directory, prefix: '/ws/', inject: ['message'] })).await()
  await app.plugin(websocketListener, { host, port: 0 }).await()
  await app.plugin(httpListener, { host, port: 0 }).await()
  /** @type {Promise<unknown[]>[]} */
  const closed = []
  for (const address of [app.websocket.address(), app.http.address()]) {
    assert.ok(address)
    const events = new EventEmitter()
    const opened = once(events, 'open', { signal: AbortSignal.timeout(4_000) })
    const client = connectWebSocketEndpoint(`ws://${host}:${address.port}/ws/echo?source=test`, {
      maxAttempts: 0,
      onOpen() { events.emit('open') },
      onClose(info) { events.emit('close', info.code) },
    })
    t.after(() => client.close())
    await opened
    closed.push(once(events, 'close', { signal: AbortSignal.timeout(4_000) }))
    assert.equal(await client.call('echo'), 'through Cordis')
  }
  await routes.dispose()
  assert.deepEqual(await Promise.all(closed), [[1001], [1001]])
})

test('loads routes against the WebSocket service in the supplied Cordis scope', { timeout: 5_000 }, async (t) => {
  const directory = await fixtures(t, {
    'echo.ws.mjs': 'export default () => ({ onMessage: (conn, msg) => conn.send(msg) })',
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const scope = app.isolate('websocket', Symbol('isolated websocket'))
  await scope.plugin(websocket).await()
  assert.equal(app.get('websocket'), undefined)
  await loadWebSocketRoutes(scope, { directory })
  await scope.plugin(websocketListener, { host, port: 0 }).await()
  const address = scope.websocket.address()
  assert.ok(address)
  const peer = new WebSocket(`ws://${host}:${address.port}/echo`)
  t.after(() => peer.terminate())
  const signal = AbortSignal.timeout(2_000)
  await once(peer, 'open', { signal })
  const echoed = once(peer, 'message', { signal })
  peer.send('isolated')
  assert.equal(String((await echoed)[0]), 'isolated')
})

test('cancels a route load when its isolated WebSocket service is withdrawn during import', {
  timeout: 6_000,
}, async (t) => {
  const app = new Context()
  const key = 'ainess-websocket-scoped-load-test'
  const events = new EventEmitter()
  const later = t.mock.fn()
  events.on('later', later)
  Reflect.set(globalThis, key, events)
  t.after(async () => {
    events.emit('continue')
    await app.fiber.dispose()
    Reflect.deleteProperty(globalThis, key)
  })
  const directory = await fixtures(t, {
    'a.ws.mjs': `
      const events = Reflect.get(globalThis, ${JSON.stringify(key)})
      await new Promise(resolve => { events.once('continue', resolve); events.emit('loading') })
      export default null
    `,
    'b.ws.mjs': `Reflect.get(globalThis, ${JSON.stringify(key)}).emit('later'); export default () => ({})`,
  })
  await app.plugin(websocket).await()
  const scope = app.isolate('websocket', Symbol('isolated websocket'))
  const provider = await scope.plugin(websocket).await()
  const waiting = once(events, 'loading', { signal: AbortSignal.timeout(4_000) })
  const loading = loadWebSocketRoutes(scope, { directory })
  void loading.catch(() => {})
  await waiting
  await provider.dispose()
  await scope.plugin(websocket).await()
  events.emit('continue')
  await assert.doesNotReject(loading)
  assert.equal(later.mock.callCount(), 0)
})

test('maps file segments to the path encoded by native WebSocket URLs', { timeout: 5_000 }, async (t) => {
  const directory = await fixtures(t, {
    '部门 A/聊天.ws.mjs': 'export default () => ({ onMessage: (conn, msg) => conn.send(msg) })',
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  await app.plugin(websocketRoutes({ directory, prefix: '/v1/%E5%85%AC%E5%BC%80' })).await()
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const address = app.websocket.address()
  assert.ok(address)
  const client = new WebSocket(new URL(`/v1/公开/部门 A/聊天`, `ws://${host}:${address.port}`))
  t.after(() => client.terminate())
  const signal = AbortSignal.timeout(2_000)
  await once(client, 'open', { signal })
  const echoed = once(client, 'message', { signal })
  client.send('hello')
  assert.equal(String((await echoed)[0]), 'hello')
})

test('preflights file paths and rolls back earlier routes when registration conflicts', {
  timeout: 8_000,
}, async (t) => {
  const duplicate = await fixtures(t, {
    '(group)/echo.ws.mjs': 'throw new Error("unexpected import")',
    'echo/index.ws.mjs': 'throw new Error("unexpected import")',
  })
  const dynamic = await fixtures(t, {
    '[id].ws.mjs': 'throw new Error("unexpected import")',
  })
  const alias = await fixtures(t, {
    '%E8%81%8A%E5%A4%A9.ws.mjs': 'throw new Error("unexpected import")',
    '聊天.ws.mjs': 'throw new Error("unexpected import")',
  })
  const dot = await fixtures(t, {
    '%2e%2e/echo.ws.mjs': 'throw new Error("unexpected import")',
  })
  const conflict = await fixtures(t, {
    'a.ws.mjs': 'export default () => ({})',
    'z.ws.mjs': 'export default () => ({})',
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  await assert.rejects(loadWebSocketRoutes(app, { directory: duplicate }), /duplicate.*echo.*echo\.ws.*index\.ws/i)
  await assert.rejects(loadWebSocketRoutes(app, { directory: dynamic }), /\[id\]\.ws\.mjs.*static/i)
  await assert.rejects(loadWebSocketRoutes(app, { directory: alias }), /duplicate.*%E8%81%8A.*聊天\.ws/i)
  await assert.rejects(loadWebSocketRoutes(app, { directory: dot, prefix: '/ws' }), /%2e%2e\/echo.*dot segment/i)

  const remove = app.websocket.route('/ws/z', {})
  await assert.rejects(
    loadWebSocketRoutes(app, { directory: conflict, prefix: '/ws' }),
    /z\.ws\.mjs.*already registered/,
  )
  // Registering both paths again demonstrates that rollback released this batch only.
  const first = app.websocket.route('/ws/a', {})
  assert.throws(() => app.websocket.route('/ws/z', {}), /already registered/)
  await Promise.all([first(), remove()])
})

test('rejects asynchronous route factories without starting lazy thenables', async (t) => {
  const directory = await fixtures(t, {
    'lazy.ws.mjs': `
      export default ctx => ({ then() { ctx.get('startLazyRoute')() } })
    `,
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const start = t.mock.fn()
  app.provide('startLazyRoute', start)

  await assert.rejects(loadWebSocketRoutes(app, { directory }), /lazy\.ws\.mjs.*synchronously/)
  assert.equal(start.mock.callCount(), 0)
})

test('skips the remaining imports and registration after disposal during a module import', {
  timeout: 8_000,
}, async (t) => {
  const key = 'ainess-websocket-load-test'
  const events = new EventEmitter()
  Reflect.set(globalThis, key, events)
  const later = t.mock.fn()
  events.on('later', later)
  const app = new Context()
  t.after(async () => {
    events.emit('continue')
    await app.fiber.dispose()
    Reflect.deleteProperty(globalThis, key)
  })
  const directory = await fixtures(t, {
    'a.ws.mjs': `
      const events = Reflect.get(globalThis, ${JSON.stringify(key)})
      await new Promise(resolve => { events.once('continue', resolve); events.emit('loading') })
      export default () => ({})
    `,
    'b.ws.mjs': `Reflect.get(globalThis, ${JSON.stringify(key)}).emit('later'); export default () => ({})`,
  })
  await app.plugin(websocket).await()
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const loading = once(events, 'loading', { signal: AbortSignal.timeout(4_000) })
  const routes = app.plugin(websocketRoutes({ directory }))
  await loading
  const disposing = routes.dispose()
  events.emit('continue')
  await disposing
  await routes.await()
  assert.equal(later.mock.callCount(), 0)

  const address = app.websocket.address()
  assert.ok(address)
  const client = new WebSocket(`ws://${host}:${address.port}/a`)
  t.after(() => client.terminate())
  client.on('error', () => {})
  await assert.rejects(once(client, 'open', { signal: AbortSignal.timeout(4_000) }), /404/)
})
