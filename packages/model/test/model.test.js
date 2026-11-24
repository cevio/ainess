import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { defineController, http, httpListener } from '@ainess/http'
import { defineModel, defineModelOperation, models } from '@ainess/model'
import { typeorm } from '@ainess/typeorm'
import { Context } from '@deepseek-ai/cordis'
import { cancelValidations, orderEntity, ordersModel, resourceModel } from './fixtures/orders.js'

const call = { caller: { tenantId: 'shop', userId: 'buyer' } }

/** @param {Context} app */
function openModelScope(app) {
  return app.plugin({ name: 'model-scope', inject: ['models'], apply() {} }).await()
}

/** @param {string} url @param {string} method @param {number} status @param {unknown} [body] */
async function checkResponse(url, method, status, body) {
  const response = await fetch(url, { method })
  assert.equal(response.status, status)
  if (body === undefined) await response.text()
  else assert.deepEqual(await response.json(), body)
}

test('HTTP routes follow their individual Model method dependencies', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(models).await()
  await app.plugin(http).await()
  const scope = await openModelScope(app)
  const registration = scope.ctx.models.register(ordersModel)
  await registration.fiber.await()

  await app.plugin({
    inject: ['http', 'models', 'models.orders', 'models.orders.cancellationPolicy'],
    apply(ctx) {
      ctx.http.route('GET', '/orders/policy/:status', defineController(async (request, { params }) => {
        const operation = ctx.models.orders.cancellationPolicy
        const parsed = await operation.inputSchema['~standard'].validate({ status: params.status })
        if (parsed.issues) return request.throw(400, 'Invalid status')
        return operation(parsed.value, call)
      }))
    },
  }).await()
  const cancelRoute = await app.plugin({
    inject: ['http', 'models', 'models.orders', 'models.orders.cancelOrder'],
    apply(ctx) {
      ctx.http.route('POST', '/orders/:id/cancel', defineController(async (request, { params }) => {
        const operation = ctx.models.orders.cancelOrder
        const parsed = await operation.inputSchema['~standard'].validate({ orderId: params.id })
        if (parsed.issues) return request.throw(400, 'Invalid order ID')
        const result = await operation(parsed.value, call)
        if (result.kind === 'success') return result.value
        request.status = result.code === 'ORDER_NOT_FOUND' ? 404 : 409
        return { code: result.code }
      }))
    },
  }).await()

  const listener = await app.plugin(httpListener, { host: '127.0.0.1', port: 0 }).await()
  const address = app.http.address()
  assert.ok(address)
  const origin = `http://127.0.0.1:${address.port}`

  try {
    await checkResponse(`${origin}/orders/policy/pending`, 'GET', 200, { canCancel: true })
    await checkResponse(`${origin}/orders/42/cancel`, 'POST', 404)

    const database = await app.plugin(typeorm, { type: 'sqljs', entities: [orderEntity], synchronize: true }).await()
    const repository = app.typeorm.getRepository(orderEntity)
    await repository.insert({ id: 42, tenantId: 'shop', buyerId: 'buyer', status: 'pending' })
    await cancelRoute.await()

    const before = cancelValidations
    await checkResponse(`${origin}/orders/42/cancel`, 'POST', 200, { id: 42, status: 'cancelled' })
    assert.equal(cancelValidations, before + 1)
    assert.equal((await repository.findOneBy({ id: 42 }))?.status, 'cancelled')
    await checkResponse(`${origin}/orders/invalid/cancel`, 'POST', 400)

    await database.dispose()
    await checkResponse(`${origin}/orders/42/cancel`, 'POST', 404)
    await checkResponse(`${origin}/orders/policy/paid`, 'GET', 200, { canCancel: false })

    await app.models.unregister(registration)
    await checkResponse(`${origin}/orders/policy/paid`, 'GET', 404)
    assert.ok(app.models)
  } finally {
    await listener.dispose()
  }
})

test('registrations reject duplicates and unload only the Model owned by their handle', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(models).await()
  const scope = await openModelScope(app)
  const first = scope.ctx.models.register(ordersModel)
  await first.fiber.await()

  const duplicate = scope.ctx.models.register(ordersModel)
  await assert.rejects(duplicate.fiber.await(), /service "models\.orders" has been registered/)
  await duplicate.fiber.dispose()
  assert.deepEqual(await app.models.orders.cancellationPolicy({ status: 'pending' }, call), { canCancel: true })

  await app.models.unregister(first)
  assert.equal(app.get('models.orders', false), undefined)
  const next = scope.ctx.models.register(ordersModel)
  await next.fiber.await()
  await app.models.unregister(first)
  assert.ok(app.get('models.orders.cancellationPolicy'))

  await scope.dispose()
  assert.equal(app.get('models.orders', false), undefined)
  assert.equal(app.get('models.orders.cancellationPolicy', false), undefined)
  assert.ok(app.models)
})

test('rejects malformed Model operation declarations before mounting', () => {
  /** @type {import('@standard-schema/spec').StandardSchemaV1} */
  const schema = { '~standard': { vendor: 'ainess-test', version: 1, validate: (value) => ({ value }) } }
  const options = { schema, execute() {} }
  for (const inject of ['typeorm', [null], ['']]) {
    assert.throws(() => Reflect.apply(defineModelOperation, undefined, [{ ...options, inject }]), {
      name: 'TypeError',
      message: /inject/,
    })
  }
  assert.throws(() => Reflect.apply(defineModelOperation, undefined, [{ ...options, execute: null }]), {
    name: 'TypeError',
    message: /execute/,
  })
  assert.throws(() => Reflect.apply(defineModelOperation, undefined, [{ ...options, schema: {} }]), {
    name: 'TypeError',
    message: /schema/,
  })
})

test('model definitions reject methods without a string service name', () => {
  const key = Symbol('hidden')
  assert.throws(() => {
    // @ts-expect-error A symbol cannot be used as the dotted service name.
    defineModel('orders', { [key]: ordersModel.methods.cancellationPolicy })
  }, /Model method name must be a string/)
})

test('model definitions preserve own string-named methods', () => {
  const methods = { read: resourceModel.methods.read }
  Object.defineProperty(methods, 'read', { enumerable: false })
  const definition = defineModel('resource', methods)
  assert.deepEqual(Object.keys(definition.methods), ['read'])
  assert.equal(definition.methods.read, resourceModel.methods.read)
})

test('manual registration rejects a definition that bypassed defineModel', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(models).await()
  const scope = await openModelScope(app)
  const rawDefinition = {
    name: ordersModel.name,
    methods: { ...ordersModel.methods, 'hidden.alias': ordersModel.methods.cancellationPolicy },
  }

  assert.throws(() => {
    // @ts-expect-error Manual registration requires a definition created by defineModel().
    scope.ctx.models.register(rawDefinition)
  }, /defineModel\(\)/)
  assert.equal(app.get('models.orders', false), undefined)
})

function createGate() {
  let release = () => {}
  /** @type {Promise<void>} */
  const promise = new Promise(resolve => { release = () => resolve() })
  return { promise, release }
}

test('a retiring method rejects new calls while accepted calls drain', { timeout: 5000 }, async (t) => {
  const app = new Context()
  const entered = new EventTarget()
  const releaseConsumer = createGate()
  const releaseCalls = [createGate(), createGate()]
  let closed = false
  let calls = 0
  t.after(() => {
    releaseConsumer.release()
    for (const gate of releaseCalls) gate.release()
    return app.fiber.dispose()
  })

  await app.plugin(models).await()
  const scope = await openModelScope(app)
  await scope.ctx.models.register(resourceModel).fiber.await()
  const provider = await app.plugin({
    apply(ctx) {
      ctx.provide('modelTestResource', {
        async read() {
          const id = ++calls
          if (id > 2) return 'unexpected call during unload'
          entered.dispatchEvent(new Event(`read-${id}`))
          await releaseCalls[id - 1].promise
          assert.equal(closed, false)
          if (id === 2) throw new Error('accepted call failed')
          return 'value'
        },
      })
      ctx.effect(() => () => { closed = true })
    },
  }).await()

  await app.plugin({
    inject: ['models.resource.read'],
    apply(ctx) {
      ctx.effect(() => async () => {
        entered.dispatchEvent(new Event('cleanup'))
        await releaseConsumer.promise
      })
    },
  }).await()

  const reading = Promise.all([1, 2].map(id => new Promise(resolve => {
    entered.addEventListener(`read-${id}`, resolve, { once: true })
  })))
  const read = app.models.resource.read
  const result = read(undefined, call)
  const rejected = assert.rejects(read(undefined, call), /accepted call failed/)
  await reading
  const cleaning = new Promise(resolve => entered.addEventListener('cleanup', resolve, { once: true }))
  const stopping = provider.dispose()
  await cleaning
  assert.equal(closed, false)
  await assert.rejects(read(undefined, call), /model operation "models\.resource\.read" is inactive/i)

  releaseConsumer.release()
  releaseCalls[0].release()
  assert.equal(await result, 'value')
  await setImmediate()
  assert.equal(closed, false)
  releaseCalls[1].release()

  await rejected
  await stopping
  assert.equal(closed, true)
  assert.equal(app.get('models.resource.read', false), undefined)

  await app.plugin({
    apply(ctx) {
      ctx.provide('modelTestResource', { read: async () => 'replacement' })
    },
  }).await()
  assert.equal(await app.models.resource.read(undefined, call), 'replacement')
  await assert.rejects(read(undefined, call), /model operation "models\.resource\.read" is inactive/i)
})
