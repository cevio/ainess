import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { http, httpListener } from '@ainess/http'
import { getHttpRequestSignal } from '@ainess/http/request-signal'
import { Context } from '@deepseek-ai/cordis'

test('disconnecting one Koa request aborts its signal while a concurrent request completes', {
  timeout: 5_000,
}, async (t) => {
  assert.equal(getHttpRequestSignal(), undefined)
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  /** @type {AbortSignal | undefined} */
  let slowSignal
  /** @type {AbortSignal | undefined} */
  let fastSignal
  app.http.route('GET', '/slow', async (request) => {
    const signal = getHttpRequestSignal()
    await Promise.resolve()
    assert.equal(getHttpRequestSignal(), signal)
    slowSignal = signal
    request.status = 200
    request.respond = false
    request.res.write('started')
  })
  app.http.route('GET', '/fast', (request) => {
    fastSignal = getHttpRequestSignal()
    request.body = 'finished'
  })
  await app.plugin(httpListener, { host: '127.0.0.1', port: 0 }).await()
  const address = app.http.address()
  assert.ok(address)
  const origin = `http://127.0.0.1:${address.port}`
  const client = new AbortController()

  try {
    const slow = await fetch(`${origin}/slow`, { signal: client.signal })
    assert.equal(slow.status, 200)
    assert.ok(slowSignal)
    assert.equal(await (await fetch(`${origin}/fast`)).text(), 'finished')
    assert.ok(fastSignal)
    assert.notEqual(slowSignal, fastSignal)
    assert.equal(slowSignal.aborted, false)
    assert.equal(fastSignal.aborted, false)

    const aborted = once(slowSignal, 'abort', { signal: AbortSignal.timeout(3_000) })
    client.abort()
    await aborted
    assert.equal(slowSignal.aborted, true)
    assert.equal(fastSignal.aborted, false)
    assert.equal(getHttpRequestSignal(), undefined)
  } finally {
    client.abort()
  }
})
