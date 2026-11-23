import assert from 'node:assert/strict'
import { once } from 'node:events'
import { get } from 'node:http'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { loadHttpControllers } from '@ainess/http/controllers'
import { httpNext } from '@ainess/http-next'
import { Context } from '@deepseek-ai/cordis'
import { dir, dev, submitServerAction } from './fixtures/next.js'

const directory = new URL('./fixtures/controllers/', import.meta.url)

test('Next and Ainess serve API, RSC, a Server Action, and assets on one port', { timeout: 90_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  await app.plugin({
    inject: ['http'],
    apply(ctx) {
      ctx.http.use(async (request, next) => {
        request.set('x-ainess', 'koa')
        await next()
      })
      return loadHttpControllers(ctx, { directory, prefix: '/-' })
    },
  }).await()
  const options = { host: '127.0.0.1', port: 0, prepare: httpNext({ dir, dev, apiPrefix: '/-' }) }
  const listener = await app.plugin(httpListener, options).await()
  const address = app.http.address()
  assert.ok(address)
  const origin = `http://127.0.0.1:${address.port}`

  const health = await fetch(`${origin}/-/health`)
  assert.equal(health.headers.get('x-ainess'), 'koa')
  assert.deepEqual(await health.json(), { ok: true })
  const missing = await fetch(`${origin}/-/missing`)
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('x-ainess'), 'koa')
  await missing.text()
  const similarPrefix = await fetch(`${origin}/-extra`)
  assert.equal(similarPrefix.status, 404)
  assert.equal(similarPrefix.headers.get('x-ainess'), null)
  await similarPrefix.text()

  for (const [path, owner] of [['/-/health', 'koa'], ['/web/../-/health', undefined]]) {
    const actual = await new Promise((resolve, reject) => {
      const request = get(origin, { path: `${origin}${path}`, signal: AbortSignal.timeout(5_000) }, (response) => {
        response.resume()
        resolve(response.headers['x-ainess'])
      })
      request.once('error', reject)
    })
    assert.equal(actual, owner)
  }

  const page = await fetch(origin)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('x-ainess'), null)
  const html = await page.text()
  assert.match(html, /Next server component/)
  assert.match(html, /data-request-signal="active"/)
  assert.match(html, /Client count/)
  const asset = html.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js[^\"]*)"/)?.[1]
  assert.ok(asset)
  const script = await fetch(new URL(asset, origin))
  assert.equal(script.status, 200)
  assert.ok((await script.text()).length > 0)
  assert.equal(await (await fetch(`${origin}/probe.txt`)).text(), 'Next public file\n')

  const flight = await fetch(origin, { headers: { rsc: '1' } })
  assert.match(flight.headers.get('content-type') ?? '', /^text\/x-component/)
  assert.match(await flight.text(), /Next server component/)

  const reply = await fetch(`${origin}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 'original request body' }),
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.headers.get('set-cookie'), 'echo=ok; Path=/; HttpOnly')
  assert.deepEqual(await reply.json(), { value: 'original request body' })

  await submitServerAction(origin, html)

  const client = new AbortController()
  const signalEndpoint = `${origin}/api/request-signal`
  try {
    const streaming = await fetch(signalEndpoint, { signal: client.signal })
    assert.equal(streaming.status, 200)
  } finally {
    client.abort()
  }
  const disconnected = await fetch(`${signalEndpoint}?disconnected`, { signal: AbortSignal.timeout(5_000) })
  assert.equal(disconnected.status, 204)

  if (dev) {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/_next/hmr?id=ainess-http-next-test`)
    t.after(() => socket.close())
    await once(socket, 'open', { signal: AbortSignal.timeout(10_000) })
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(10_000) })
    await Promise.all([listener.dispose(), closed])
    assert.equal(app.http.address(), null)

    const restarted = await app.plugin(httpListener, { ...options, port: address.port }).await()
    assert.deepEqual(await (await fetch(`${origin}/-/health`)).json(), { ok: true })
    assert.match(await (await fetch(origin)).text(), /Next server component/)
    await restarted.dispose()
  } else {
    await listener.dispose()
  }
  assert.equal(app.http.address(), null)
  await assert.rejects(fetch(origin), TypeError)
})
