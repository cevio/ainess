import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { Context } from '@deepseek-ai/cordis'

const host = '127.0.0.1'

/** @param {import('@ainess/http').HttpService} service */
function origin(service) {
  const address = service.address()
  assert.ok(address)
  return `http://${host}:${address.port}`
}

test('Cordis consumers register Koa middleware and routes with params and static priority', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())

  const routes = app.plugin({
    inject: ['http'],
    apply(ctx) {
      ctx.http.use(async (request, next) => {
        request.set('x-registered', 'yes')
        await next()
      })
      ctx.http.route('GET', '/users/:id', async (request, next) => {
        request.set('x-route', 'users')
        await next()
      }, (request) => {
        request.body = { id: request.params.id }
      })
      ctx.http.route('GET', '/users/current', (request) => {
        request.body = 'current user'
      })
      ctx.http.route('GET', '/files/*', (request) => {
        request.body = request.params['*']
      })
    },
  })
  await app.plugin(http).await()
  await routes.await()
  assert.equal(app.http.address(), null)
  await app.plugin(httpListener, { host, port: 0 }).await()
  const url = origin(app.http)

  const user = await fetch(`${url}/users/42?sort=name`)
  assert.equal(user.status, 200)
  assert.equal(user.headers.get('x-registered'), 'yes')
  assert.equal(user.headers.get('x-route'), 'users')
  assert.deepEqual(await user.json(), { id: '42' })
  assert.equal(await (await fetch(`${url}/users/current`)).text(), 'current user')
  assert.equal(await (await fetch(`${url}/files/docs/readme.md`)).text(), 'docs/readme.md')
  const head = await fetch(`${url}/users/42`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')

  await routes.dispose()
  const missing = await fetch(`${url}/users/42`)
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('x-registered'), null)
  await missing.text()
})

test('conflicting routes roll back registrations from the failed consumer', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  app.http.route('GET', '/users/:id', (request) => {
    request.body = request.params.id
  })
  const conflicting = app.plugin({
    inject: ['http'],
    apply(ctx) {
      ctx.http.route('GET', '/extra', (request) => { request.body = 'extra' })
      ctx.http.route('GET', '/users/:name', (request) => { request.body = request.params.name })
    },
  })
  await assert.rejects(conflicting.await(), /already declared/i)

  await app.plugin(httpListener, { host, port: 0 }).await()
  const url = origin(app.http)
  assert.equal(await (await fetch(`${url}/users/42`)).text(), '42')
  const extra = await fetch(`${url}/extra`)
  assert.equal(extra.status, 404)
  await extra.text()
})

test('a port conflict cleans up the prepared handler and allows another listener', async (t) => {
  const occupied = createServer().listen(0, host)
  await once(occupied, 'listening')
  const address = occupied.address()
  assert.ok(address && typeof address !== 'string')
  const app = new Context()
  t.after(async () => {
    await app.fiber.dispose()
    await new Promise((resolve) => occupied.close(resolve))
  })
  await app.plugin(http).await()
  const cleaned = t.mock.fn()
  const failed = app.plugin(httpListener, {
    host,
    port: address.port,
    prepare(server, handleHttp) {
      assert.equal(server.listening, false)
      return { handle: handleHttp, dispose: cleaned }
    },
  })
  await assert.rejects(failed.await(), { code: 'EADDRINUSE' })
  assert.equal(cleaned.mock.callCount(), 1)
  assert.equal(app.http.address(), null)

  const listener = await app.plugin(httpListener, { host, port: 0 }).await()
  const url = origin(app.http)
  await assert.rejects(app.plugin(httpListener, { host, port: 0 }).await(), /already has a listener/i)
  await listener.dispose()
  assert.equal(app.http.address(), null)
  await assert.rejects(fetch(url), TypeError)
})

test('disposing a listener during preparation releases the handler without opening the port', {
  timeout: 5_000,
}, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  const events = new EventEmitter()
  const preparing = once(events, 'preparing')
  const open = t.mock.fn()
  const cleaned = t.mock.fn()
  const listener = app.plugin(httpListener, {
    host,
    port: 0,
    async prepare(server, handleHttp) {
      const ready = once(events, 'ready')
      server.on('listening', open)
      events.emit('preparing')
      await ready
      return { handle: handleHttp, dispose: cleaned }
    },
  })

  await preparing
  const disposed = listener.dispose()
  events.emit('ready')
  await disposed
  assert.equal(open.mock.callCount(), 0)
  assert.equal(cleaned.mock.callCount(), 1)
  assert.equal(app.http.address(), null)
})

test('retiring the HTTP provider during preparation prevents the old listener from binding', {
  timeout: 5_000,
}, async (t) => {
  const app = new Context()
  const events = new EventEmitter()
  t.after(() => {
    events.emit('ready')
    return app.fiber.dispose()
  })
  const provider = await app.plugin(http).await()
  const preparing = once(events, 'preparing', { signal: AbortSignal.timeout(3_000) })
  const open = t.mock.fn()
  const cleaned = t.mock.fn()
  const listener = app.plugin(httpListener, {
    host,
    port: 0,
    async prepare(server, handleHttp) {
      const ready = once(events, 'ready')
      server.on('listening', open)
      events.emit('preparing')
      await ready
      return { handle: handleHttp, dispose: cleaned }
    },
  })

  await preparing
  const disposed = provider.dispose()
  events.emit('ready')
  await disposed
  await listener.await()
  assert.equal(open.mock.callCount(), 0)
  assert.equal(cleaned.mock.callCount(), 1)
})

test('listener disposal drains active responses before closing the prepared handler', { timeout: 5_000 }, async (t) => {
  const app = new Context()
  const events = new EventEmitter()
  t.after(() => {
    events.emit('release')
    return app.fiber.dispose()
  })
  await app.plugin(http).await()
  const received = once(events, 'received')
  const cleaned = t.mock.fn()
  app.http.route('GET', '/slow', async (request) => {
    const release = once(events, 'release')
    events.emit('received')
    await release
    assert.equal(cleaned.mock.callCount(), 0)
    request.body = 'finished'
  })
  const listener = await app.plugin(httpListener, {
    host,
    port: 0,
    prepare(_server, handleHttp) {
      return { handle: handleHttp, dispose: cleaned }
    },
  }).await()
  const response = fetch(`${origin(app.http)}/slow`)
  await received
  const disposed = listener.dispose()
  events.emit('release')
  assert.equal(await (await response).text(), 'finished')
  await disposed
  assert.equal(cleaned.mock.callCount(), 1)
})

test('hands only unanswered route misses to the listener fallback after Koa unwinds', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()

  app.http.use(async (request, next) => {
    if (request.path === '/read') {
      const consumed = once(request.req, 'end')
      request.req.resume()
      await consumed
    }
    await next()
    request.set('x-koa', 'after-next')
    if (request.path === '/middleware-404') request.status = 404
  })
  app.http.route('GET', '/api/missing-user', (request) => {
    request.status = 404
    request.body = 'missing user'
  })

  const listener = await app.plugin(httpListener, {
    host,
    port: 0,
    prepare(_server, handle) {
      return {
        handle,
        onRouteMiss(_request, response) {
          response.setHeader('x-handler', 'fallback')
          response.end('page')
        },
      }
    },
  }).await()
  const url = origin(app.http)
  const page = await fetch(`${url}/page`)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-koa'), 'after-next')
  assert.equal(page.headers.get('x-handler'), 'fallback')
  assert.equal(await page.text(), 'page')

  const missingUser = await fetch(`${url}/api/missing-user`)
  assert.equal(missingUser.status, 404)
  assert.equal(await missingUser.text(), 'missing user')
  const explicit = await fetch(`${url}/middleware-404`)
  assert.equal(explicit.status, 404)
  assert.equal(explicit.headers.get('x-handler'), null)
  await explicit.text()
  const consumed = await fetch(`${url}/read`, { method: 'POST', body: 'already read by Koa' })
  assert.equal(consumed.status, 404)
  assert.equal(consumed.headers.get('x-handler'), null)
  await consumed.text()

  await listener.dispose()
  await app.plugin(httpListener, { host, port: 0 }).await()
  const plain = await fetch(`${origin(app.http)}/page`)
  assert.equal(plain.status, 404)
  assert.equal(plain.headers.get('x-handler'), null)
  await plain.text()
})

test('a response that stays open is disconnected at the shutdown deadline', { timeout: 5_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  app.http.route('GET', '/events', (request) => {
    const stream = new PassThrough()
    request.body = stream
    stream.write('started')
  })
  const listener = await app.plugin(httpListener, { host, port: 0, shutdownTimeoutMs: 25 }).await()
  const response = await fetch(`${origin(app.http)}/events`)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), 'started')

  await listener.dispose()
  await assert.rejects(reader.read(), TypeError)
  assert.equal(app.http.address(), null)
})
