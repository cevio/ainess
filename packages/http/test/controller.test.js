import assert from 'node:assert/strict'
import test from 'node:test'
import { defineController, http, httpListener } from '@ainess/http'
import { Context } from '@deepseek-ai/cordis'

test('a controller validates once and passes the transformed input alongside the original Koa context', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  let validations = 0
  let executions = 0

  /** @type {import('@standard-schema/spec').StandardSchemaV1<unknown, { id: number, limit: number, name: string }>} */
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'ainess-test',
      async validate(input) {
        validations++
        const { params, query, body } = /** @type {import('@ainess/http').HttpControllerInput} */ (input)
        if (!body || typeof body !== 'object' || !('name' in body) || typeof body.name !== 'string') {
          return { issues: [{ message: 'Expected a name', path: ['body', 'name'] }] }
        }
        return { value: { id: Number(params.id), limit: Number(query.limit), name: body.name.trim() } }
      },
    },
  }

  app.http.route('POST', '/items/:id', async (request, next) => {
    request.req.setEncoding('utf8')
    let body = ''
    for await (const chunk of request.req) body += chunk
    Object.assign(request.request, { body: JSON.parse(body) })
    await next()
  }, defineController({
    schema,
    handle(request, input) {
      executions++
      assert.equal(request.params.id, '42')
      assert.equal(request.query.limit, '3')
      assert.deepEqual(Reflect.get(request.request, 'body'), { name: '  Ainess  ' })
      return { ...input, displayId: input.id.toFixed(0) }
    },
  }))

  await app.plugin(httpListener, { host: '127.0.0.1', port: 0 }).await()
  const address = app.http.address()
  assert.ok(address)
  const url = `http://127.0.0.1:${address.port}/items/42?limit=3`
  const valid = await fetch(url, { method: 'POST', body: JSON.stringify({ name: '  Ainess  ' }) })
  assert.equal(valid.status, 200)
  assert.deepEqual(await valid.json(), { id: 42, limit: 3, name: 'Ainess', displayId: '42' })
  assert.equal(validations, 1)
  assert.equal(executions, 1)

  const invalid = await fetch(url, { method: 'POST', body: JSON.stringify({ name: false }) })
  assert.equal(invalid.status, 400)
  assert.equal(await invalid.text(), 'Invalid request')
  assert.equal(validations, 2)
  assert.equal(executions, 1)
})

test('a controller without a schema can write a Koa response and return undefined', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  app.http.route('GET', '/items/:id', defineController({
    handle(request, input) {
      assert.equal(input.params.id, '42')
      assert.equal(input.query.limit, '3')
      assert.equal(input.body, undefined)
      request.status = 202
      request.set('x-controller', 'manual')
      request.body = 'accepted'
    },
  }))
  await app.plugin(httpListener, { host: '127.0.0.1', port: 0 }).await()
  const address = app.http.address()
  assert.ok(address)
  const response = await fetch(`http://127.0.0.1:${address.port}/items/42?limit=3`)
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('x-controller'), 'manual')
  assert.equal(await response.text(), 'accepted')
})

test('a function controller receives the Koa context and raw input and can return a response body', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  app.http.route('GET', '/items/:id', defineController(async (request, { params, query, body }) => {
    request.set('x-controller', 'function')
    return { id: params.id, limit: query.limit, hasBody: body !== undefined }
  }))

  await app.plugin(httpListener, { host: '127.0.0.1', port: 0 }).await()
  const address = app.http.address()
  assert.ok(address)
  const response = await fetch(`http://127.0.0.1:${address.port}/items/42?limit=3`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-controller'), 'function')
  assert.deepEqual(await response.json(), { id: '42', limit: '3', hasBody: false })
})

test('callable controller options use their configured schema and handle', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(http).await()
  /** @type {import('@ainess/http').HttpControllerOptions<{ id: number }>} */
  const options = {
    schema: {
      '~standard': {
        version: 1,
        vendor: 'ainess-test',
        validate: () => ({ value: { id: 42 } }),
      },
    },
    handle(_request, { id }) {
      return { id }
    },
  }
  const callableOptions = Object.assign(() => ({ id: 0 }), options)
  app.http.route('GET', '/items/:id', defineController(callableOptions))

  await app.plugin(httpListener, { host: '127.0.0.1', port: 0 }).await()
  const address = app.http.address()
  assert.ok(address)
  const response = await fetch(`http://127.0.0.1:${address.port}/items/42`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: 42 })
})
