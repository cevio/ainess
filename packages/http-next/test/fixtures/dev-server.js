import assert from 'node:assert/strict'
import { once } from 'node:events'
import { http, httpListener } from '@ainess/http'
import { httpNext } from '@ainess/http-next'
import { Context } from '@deepseek-ai/cordis'
import { dir } from './next.js'

const app = new Context()
const stop = once(process, 'SIGTERM')
try {
  await app.plugin(http).await()
  app.http.route('GET', '/-/health', (request) => { request.body = { ok: true } })
  const listener = await app.plugin(httpListener, {
    host: '127.0.0.1',
    port: Number(process.argv[2]),
    prepare: httpNext({ dir, dev: true, apiPrefix: '/-' }),
  }).await()
  try {
    const address = app.http.address()
    assert.ok(address && process.send)
    process.send(address.port)
    await stop
  } finally {
    await listener.dispose()
  }
} finally {
  await app.fiber.dispose()
}
process.exit()
