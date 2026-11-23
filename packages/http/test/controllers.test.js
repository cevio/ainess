import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { loadHttpControllers } from '@ainess/http/controllers'
import { Context } from '@deepseek-ai/cordis'

const host = '127.0.0.1'
const directory = new URL('./fixtures/controllers/', import.meta.url)

/** @param {Context} app */
function origin(app) {
  const address = app.http.address()
  assert.ok(address)
  return `http://${host}:${address.port}`
}

/** @param {Context} app */
function provideGreeting(app) {
  return app.plugin({
    apply(ctx) {
      ctx.provide('greeting', 'through Cordis')
    },
  }).await()
}

test('loads index, dynamic and catch-all controllers with the consumer’s injected services', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await provideGreeting(app)
  const routes = await app.plugin({
    inject: ['http', 'greeting'],
    apply(ctx) {
      return loadHttpControllers(ctx, { directory, prefix: '/-/' })
    },
  }).await()
  await app.plugin(httpListener, { host, port: 0 }).await()
  const url = origin(app)

  assert.deepEqual(await (await fetch(`${url}/-`)).json(), { root: true })
  assert.deepEqual(await (await fetch(`${url}/-/users/42`)).json(), { id: '42', greeting: 'through Cordis' })
  const created = await fetch(`${url}/-/users/42`, { method: 'POST' })
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { id: '42' })
  assert.deepEqual(await (await fetch(`${url}/-/files/docs/index`)).json(), {
    parts: 'docs/index',
    hasWildcard: false,
  })
  const emptyCatchAll = await fetch(`${url}/-/files/`)
  assert.equal(emptyCatchAll.status, 404)
  await emptyCatchAll.text()

  await routes.dispose()
  for (const path of ['/-', '/-/users/42', '/-/files/docs/index']) {
    const missing = await fetch(`${url}${path}`)
    assert.equal(missing.status, 404)
    await missing.text()
  }
})

test('maps grouped files to the same path and registers their independent methods', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-controller-groups-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const [group, method] of [['(staff)', 'GET'], ['(public)', 'POST']]) {
    const folder = join(directory, group, 'users')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, '[id].controller.mjs'), `export default () => ({
      method: '${method}',
      middlewares: [request => { request.body = { ...request.params, method: '${method}' } }]
    })`)
  }

  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await loadHttpControllers(app, { directory, prefix: '/tenants/[tenant]' })
  await app.plugin(httpListener, { host, port: 0 }).await()

  const url = `${origin(app)}/tenants/acme/users/42`
  assert.deepEqual(await (await fetch(url)).json(), { tenant: 'acme', id: '42', method: 'GET' })
  assert.deepEqual(await (await fetch(url, { method: 'POST' })).json(), { tenant: 'acme', id: '42', method: 'POST' })
})

test('rejects an invalid file route before executing any module in the directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-controller-preflight-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all([
    writeFile(join(directory, 'index.controller.mjs'), 'throw new Error("valid module executed")'),
    writeFile(join(directory, 'user-[id].controller.mjs'), 'throw new Error("invalid module executed")'),
  ])

  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await assert.rejects(loadHttpControllers(app, { directory }), /user-\[id\]\.controller\.mjs.*invalid static segment/)
})

test('HEAD falls back to GET when a file catch-all has no remaining path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-controller-head-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, '[...parts].controller.mjs'), `export default () => ({
    method: 'HEAD',
    middlewares: [request => {
      request.status = 204
      request.set('x-path', request.params.parts)
    }]
  })`)

  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  app.http.route('GET', '/files/', (request) => { request.body = 'index' })
  app.http.route('HEAD', '/raw/*', (request) => { request.status = 204 })
  await loadHttpControllers(app, { directory, prefix: '/files' })
  await app.plugin(httpListener, { host, port: 0 }).await()

  const url = origin(app)
  const index = await fetch(`${url}/files/`, { method: 'HEAD' })
  assert.equal(index.status, 200)
  const entry = await fetch(`${url}/files/docs/index`, { method: 'HEAD' })
  assert.equal(entry.status, 204)
  assert.equal(entry.headers.get('x-path'), 'docs/index')
  assert.equal((await fetch(`${url}/raw/`, { method: 'HEAD' })).status, 204)
})

test('a conflict rolls back the directory and allows a retry after removing the existing route', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await provideGreeting(app)
  const removeExisting = app.http.route('GET', '/-/users/:name', (request) => { request.body = request.params.name })
  await app.plugin(httpListener, { host, port: 0 }).await()
  const url = origin(app)

  const options = { directory, prefix: '/-' }
  await assert.rejects(loadHttpControllers(app, options), /users\/\[id\]\.controller\.js.*already declared/)
  assert.equal(await (await fetch(`${url}/-/users/original`)).text(), 'original')
  for (const path of ['/-', '/-/files/docs/index']) {
    const missing = await fetch(`${url}${path}`)
    assert.equal(missing.status, 404)
    await missing.text()
  }

  await removeExisting()
  await loadHttpControllers(app, options)
  assert.deepEqual(await (await fetch(`${url}/-`)).json(), { root: true })
})

test('an invalid factory result fails before the directory registers a route', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-controller-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await Promise.all([
    writeFile(join(directory, 'index.controller.mjs'), `export default () => ({
      method: 'GET', middlewares: [request => { request.body = 'loaded' }]
    })`),
    writeFile(join(directory, 'invalid.controller.mjs'), `export default () => ({ method: 'GET', middlewares: [] })`),
  ])
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await app.plugin(httpListener, { host, port: 0 }).await()

  await assert.rejects(loadHttpControllers(app, { directory }), /invalid\.controller\.mjs.*middleware/)
  const missing = await fetch(origin(app))
  assert.equal(missing.status, 404)
  await missing.text()
})

test('rejects a promise returned by a controller factory without leaking a rejection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-controller-promise-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'index.controller.mjs'), `
    export default () => Promise.reject(new Error('factory rejection'))
  `)

  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await assert.rejects(loadHttpControllers(app, { directory }), /index\.controller\.mjs.*synchronous/)
})

for (const owner of ['controller', 'dependency']) {
  test(`disposing the ${owner} during a module import skips controller registration`, {
    timeout: 5_000,
  }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'ainess-controller-dispose-'))
    const key = `ainess-controller-test:${directory}`
    const gate = new EventEmitter()
    Reflect.set(globalThis, key, gate)
    const factory = t.mock.fn()
    gate.on('factory', factory)
    const app = new Context()
    t.after(async () => {
      gate.emit('continue')
      await app.fiber.dispose()
      Reflect.deleteProperty(globalThis, key)
      await rm(directory, { recursive: true, force: true })
    })

    await writeFile(join(directory, 'index.controller.mjs'), `
      const gate = Reflect.get(globalThis, ${JSON.stringify(key)})
      await new Promise(resolve => {
        gate.once('continue', resolve)
        gate.emit('importing')
      })
      export default () => {
        gate.emit('factory')
        return { method: 'GET', middlewares: [request => { request.body = 'loaded' }] }
      }
    `)
    await app.plugin(http).await()
    const dependency = await provideGreeting(app)
    await app.plugin(httpListener, { host, port: 0 }).await()
    const importing = once(gate, 'importing', { signal: AbortSignal.timeout(3_000) })
    const routes = app.plugin({
      inject: ['http', 'greeting'],
      apply(ctx) {
        return loadHttpControllers(ctx, { directory })
      },
    })
    await importing
    const disposed = (owner === 'controller' ? routes : dependency).dispose()
    gate.emit('continue')
    await disposed
    await routes.await()
    assert.equal(factory.mock.callCount(), 0)
    const missing = await fetch(origin(app))
    assert.equal(missing.status, 404)
    await missing.text()
  })
}
