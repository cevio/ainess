import assert from 'node:assert/strict'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { httpNext } from '@ainess/http-next'
import { Context } from '@deepseek-ai/cordis'
import { dir, dev, submitServerAction } from './fixtures/next.js'

test('koa-first forwards route misses to Next and retains an API-owned 404', { timeout: 90_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  app.http.use(async (request, next) => {
    await next()
    request.set('x-shared', 'koa')
  })
  // Next also serves a public file at this path.
  app.http.route('GET', '/probe.txt', (request) => {
    request.status = 404
    request.body = 'API resource missing'
  })
  const listener = await app.plugin(httpListener, {
    host: '127.0.0.1',
    port: 0,
    prepare: httpNext({ dir, dev, routing: 'koa-first' }),
  }).await()
  const address = app.http.address()
  assert.ok(address)
  const origin = `http://127.0.0.1:${address.port}`

  const missing = await fetch(`${origin}/probe.txt`)
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('x-shared'), 'koa')
  assert.equal(await missing.text(), 'API resource missing')

  const unmatched = await fetch(`${origin}/-/unmatched`)
  assert.equal(unmatched.status, 404)
  assert.equal(unmatched.statusText, 'Not Found')
  assert.match(unmatched.headers.get('content-type') ?? '', /^text\/html/)
  await unmatched.text()

  const page = await fetch(origin)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-shared'), 'koa')
  const html = await page.text()
  assert.match(html, /data-request-signal="active"/)
  await submitServerAction(origin, html)
  await listener.dispose()
})
