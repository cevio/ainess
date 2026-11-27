import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  defineWebSocketEndpoint,
  defineWebSocketMethod,
  WebSocketEndpointError,
  WebSocketMethodMode,
  websocket,
  websocketListener,
} from '@ainess/websocket'
import { connectWebSocketEndpoint } from '@ainess/websocket-client'
import { decodeWebSocketFrame, encodeWebSocketFrame } from '@ainess/websocket-shared'
import { WebSocketServer } from 'ws'

const host = '127.0.0.1'

/** @template T @param {AsyncIterable<T>} source */
async function collect(source) {
  /** @type {T[]} */
  const result = []
  for await (const value of source) result.push(value)
  return result
}

/** @type {import('@standard-schema/spec').StandardSchemaV1<unknown, number>} */
const numberSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => typeof value === 'number' ? { value } : { issues: [{ message: 'Expected a number' }] },
  },
}

/** @param {Context} app @param {import('node:test').TestContext} t */
async function connect(app, t) {
  const address = app.websocket.address()
  assert.ok(address)
  const events = new EventEmitter()
  const opened = once(events, 'open', { signal: AbortSignal.timeout(4_000) })
  const client = connectWebSocketEndpoint(`ws://${host}:${address.port}/ws/echo`, {
    onOpen() { events.emit('open') },
  })
  t.after(() => client.close())
  await opened
  return client
}

test('dispatches calls and events on the same route, validates data and streams in both directions', {
  timeout: 8_000,
}, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    authorize: () => ({ accept: true, state: { user: 'guest' } }),
    methods: {
      echo: {
        schema: numberSchema,
        handle(value, { connection }) { return { value, user: connection.state.user } },
      },
      sequence: {
        mode: WebSocketMethodMode.ServerStream,
        async *handle() {
          yield 1
          yield 2
        },
      },
      double: defineWebSocketMethod({
        mode: WebSocketMethodMode.Bidi,
        inputSchema: numberSchema,
        async *handle(_data, { input }) {
          for await (const value of input) yield value * 2
        },
      }),
    },
    events: {
      echo: { schema: numberSchema, handle(value, { emit }) { return emit('echoed', value) } },
    },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  assert.deepEqual(await client.call('echo', 3), { value: 3, user: 'guest' })
  await assert.rejects(client.call('echo', 'invalid'), { code: 'INVALID_PARAMS' })
  await assert.rejects(client.call('missing'), { code: 'METHOD_NOT_FOUND' })
  await assert.rejects(client.call('sequence'), { code: 'MODE_MISMATCH' })

  const events = new EventEmitter()
  const echoed = once(events, 'echoed', { signal: AbortSignal.timeout(4_000) })
  const unsubscribe = client.on('echoed', (value) => { events.emit('echoed', value) })
  client.emit('echo', 4)
  assert.deepEqual(await echoed, [4])
  unsubscribe()

  assert.deepEqual(await collect(client.stream('sequence')), [1, 2])
  const input = async function* () {
    yield 5
    yield 6
  }
  const selectInput = t.mock.fn(() => input)
  const duplex = client.stream('double', undefined, { get input() { return selectInput() } })
  assert.deepEqual(await collect(duplex), [10, 12])
  assert.equal(selectInput.mock.callCount(), 1)
})

test('queries finish during an upload and aborting an upload keeps other calls usable', {
  timeout: 8_000,
}, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  t.after(() => { events.emit('continue') })
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    methods: {
      query: { handle: () => 'ready' },
      sum: defineWebSocketMethod({
        mode: WebSocketMethodMode.ClientStream,
        inputSchema: numberSchema,
        async handle(_data, { input, signal }) {
          signal.addEventListener('abort', () => { events.emit('cancelled') }, { once: true })
          let sum = 0
          for await (const value of input) {
            sum += value
            events.emit('read', value)
          }
          return sum
        },
      }),
    },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)

  const first = once(events, 'read', { signal: AbortSignal.timeout(4_000) })
  /** @param {AbortSignal} signal */
  async function* input(signal) {
    const next = once(events, 'continue', { signal })
    yield 2
    await next
    yield 3
  }
  const selectInput = t.mock.fn(() => input)
  const upload = client.call('sum', undefined, { get input() { return selectInput() } })
  assert.deepEqual(await first, [2])
  assert.equal(await client.call('query', undefined, { timeoutMs: 1_000 }), 'ready')
  events.emit('continue')
  assert.equal(await upload, 5)
  assert.equal(selectInput.mock.callCount(), 1)

  const controller = new AbortController()
  const read = once(events, 'read', { signal: AbortSignal.timeout(4_000) })
  const cancelled = once(events, 'cancelled', { signal: AbortSignal.timeout(4_000) })
  const pending = client.call('sum', undefined, {
    signal: controller.signal,
    async *input(signal) {
      yield 7
      await once(signal, 'abort')
    },
  })
  const rejection = assert.rejects(pending, { code: 'CANCELLED' })
  assert.deepEqual(await read, [7])
  controller.abort()
  await Promise.all([rejection, cancelled])
  assert.equal(await client.call('query'), 'ready')
})

test('cancelled upload releases its consumer during asynchronous chunk validation', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  t.after(() => { events.emit('validationDone') })
  /** @type {import('@standard-schema/spec').StandardSchemaV1<unknown, unknown>} */
  const inputSchema = { '~standard': {
    version: 1,
    vendor: 'test',
    async validate(value) {
      const finish = once(events, 'validationDone')
      events.emit('validating')
      await finish
      return { value }
    },
  } }
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    methods: {
      upload: defineWebSocketMethod({
        mode: WebSocketMethodMode.ClientStream,
        inputSchema,
        async handle(_data, { input, signal }) {
          try {
            return await collect(input)
          } finally {
            events.emit('released', signal.reason)
          }
        },
      }),
      query: { handle: () => 'ready' },
    },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  const controller = new AbortController()
  const signal = AbortSignal.timeout(1_500)
  const validating = once(events, 'validating', { signal })
  const rejected = assert.rejects(client.call('upload', undefined, {
    signal: controller.signal,
    async *input() { yield 'chunk' },
  }), { code: 'CANCELLED' })
  await validating
  const released = once(events, 'released', { signal })
  controller.abort()
  await rejected
  assert.equal((await released)[0].code, 'CANCELLED')
  assert.equal(await client.call('query'), 'ready')
})

test('named endpoints receive bursts and large messages without protocol limits', { timeout: 8_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket, { maxPayload: 128, maxBufferedBytes: 128 }).await()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    methods: {
      echo: { handle: (input) => input },
      count: defineWebSocketMethod({
        mode: WebSocketMethodMode.ClientStream,
        async handle(_data, { input }) {
          let count = 0
          for await (const _ of input) count++
          return count
        },
      }),
    },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  const data = 'hello'.repeat(200_000)
  assert.equal(await client.call('echo', data), data)
  const count = await client.call('count', undefined, {
    async *input() {
      for (let index = 0; index < 1_000; index++) yield index
    },
  })
  assert.equal(count, 1_000)
})

test('middleware wraps method execution and can intercept methods and events', { timeout: 8_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const invoked = t.mock.fn()
  const done = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    middlewares: [
      async (ctx, next) => {
        if (ctx.name === 'blocked') return
        if (ctx.name === 'restricted') throw new WebSocketEndpointError('FORBIDDEN')
        await next()
        done(ctx.kind, ctx.name)
      },
    ],
    methods: {
      blocked: { handle: invoked },
      restricted: { handle: invoked },
      sequence: {
        mode: WebSocketMethodMode.ServerStream,
        async *handle() { yield 1 },
      },
    },
    events: {
      blocked: { handle: invoked },
      test: { handle: (_data, { emit }) => emit('confirmed') },
    },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  await assert.rejects(client.call('blocked'), { code: 'REQUEST_BLOCKED' })
  await assert.rejects(client.call('restricted'), { code: 'FORBIDDEN' })
  assert.deepEqual(await collect(client.stream('sequence')), [1])
  assert.equal(done.mock.calls.some(({ arguments: args }) => args.join('/') === 'method/sequence'), true)

  const events = new EventEmitter()
  const confirmed = once(events, 'confirmed', { signal: AbortSignal.timeout(4_000) })
  client.on('confirmed', () => { events.emit('confirmed') })
  client.emit('blocked')
  client.emit('test')
  await confirmed
  assert.equal(invoked.mock.callCount(), 0)
})

test('rejects empty slots in a middleware chain during endpoint definition', () => {
  assert.throws(() => defineWebSocketEndpoint({ middlewares: new Array(1) }), /array of functions/)
})

test('middleware cannot pass an intercepted request downstream after returning', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const handle = t.mock.fn()
  const refused = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    middlewares: [(_ctx, next) => {
      queueMicrotask(() => {
        try {
          void next()
        } catch (error) {
          refused(error)
        }
      })
    }],
    methods: { blocked: { handle } },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  await assert.rejects(client.call('blocked'), { code: 'REQUEST_BLOCKED' })
  assert.equal(handle.mock.callCount(), 0)
  assert.equal(refused.mock.callCount(), 1)
})

test('middleware can recover a downstream error before completing a call', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const recovered = t.mock.fn()
  const observed = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    middlewares: [
      async (_ctx, next) => {
        try {
          await next()
        } catch (error) {
          if (!(error instanceof WebSocketEndpointError) || error.code !== 'RECOVERABLE') throw error
          recovered()
        }
      },
    ],
    methods: {
      attempt: { handle() { throw new WebSocketEndpointError('RECOVERABLE') } },
    },
    onError: observed,
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  assert.equal(await client.call('attempt'), undefined)
  assert.equal(recovered.mock.callCount(), 1)
  assert.equal(observed.mock.callCount(), 0)
})

test('invalid application errors fail only their own WebSocket call', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const missingCode = new WebSocketEndpointError('', 'Details are internal')
  const invalidMessage = Object.assign(new WebSocketEndpointError('CONFIG'), { message: null })
  const observed = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    methods: {
      missingCode: { handle() { throw missingCode } },
      invalidMessage: { handle() { throw invalidMessage } },
      query: { handle: () => 'ready' },
    },
    onError: observed,
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  for (const method of ['missingCode', 'invalidMessage']) {
    const failed = assert.rejects(client.call(method), { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR' })
    const [reply] = await Promise.all([client.call('query'), failed])
    assert.equal(reply, 'ready')
  }
  assert.deepEqual(observed.mock.calls.map(call => call.arguments[0]), [missingCode, invalidMessage])
})

test('synchronous middleware forwards event errors without waiting for the observer', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  t.after(() => { events.emit('release') })
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    middlewares: [(_ctx, next) => { void next() }],
    events: {
      fail: { handle() { throw new Error('Event failed') } },
      confirm: { handle: (_data, { emit }) => emit('confirmed') },
    },
    async onError(error) {
      const release = once(events, 'release')
      events.emit('observed', error)
      await release
    },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  const signal = AbortSignal.timeout(1_500)
  const observed = once(events, 'observed', { signal })
  client.on('confirmed', () => { events.emit('confirmed') })
  client.emit('fail')
  assert.match(String((await observed)[0]), /Event failed/)
  const confirmed = once(events, 'confirmed', { signal })
  client.emit('confirm')
  await confirmed
})

test('a failed event middleware waits for work it has already started', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  t.after(() => { events.emit('release') })
  /** @type {string[]} */
  const order = []
  const observed = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    middlewares: [({ name }, next) => {
      if (name === 'first' || name === 'interrupted') {
        void next()
        throw new WebSocketEndpointError('MIDDLEWARE_FAILED')
      }
      return next()
    }],
    methods: {
      progress: {
        async handle() {
          await new Promise(resolve => setImmediate(resolve))
          return order
        },
      },
      interrupted: { async handle(_data, { signal }) { await once(signal, 'abort') } },
    },
    events: {
      first: {
        async handle() {
          const release = once(events, 'release')
          order.push('first started')
          events.emit('started')
          await release
          order.push('first finished')
        },
      },
      second: {
        handle(_data, { emit }) {
          order.push('second started')
          return emit('confirmed')
        },
      },
    },
    onError: observed,
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  const signal = AbortSignal.timeout(4_000)
  const started = once(events, 'started', { signal })
  client.on('confirmed', () => { events.emit('confirmed') })
  client.emit('first')
  client.emit('second')
  await started
  assert.deepEqual(await client.call('progress'), ['first started'])
  const confirmed = once(events, 'confirmed', { signal })
  events.emit('release')
  await confirmed
  assert.deepEqual(order, ['first started', 'first finished', 'second started'])
  assert.equal(observed.mock.callCount(), 1)
  await assert.rejects(client.call('interrupted'), { code: 'MIDDLEWARE_FAILED' })
})

test('closing a connection discards events queued behind a running handler', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  t.after(() => { events.emit('release') })
  const handled = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    events: {
      asyncWork: { async handle() {
        const release = once(events, 'release')
        events.emit('started')
        await release
        events.emit('finished')
      } },
      message: { handle(value) {
        handled(value)
        events.emit('message', value)
      } },
    },
    methods: { received: { handle: () => true } },
    onClose() { events.emit('closed') },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const first = await connect(app, t)
  const signal = AbortSignal.timeout(3_000)
  const started = once(events, 'started', { signal })
  first.emit('asyncWork')
  await started
  first.emit('message', 'first')
  assert.equal(await first.call('received'), true)
  const closed = once(events, 'closed', { signal })
  first.close()
  await closed

  const second = await connect(app, t)
  const message = once(events, 'message', { signal })
  second.emit('message', 'second')
  assert.deepEqual(await message, ['second'])
  const finished = once(events, 'finished', { signal })
  events.emit('release')
  await finished
  assert.equal(await second.call('received'), true)
  assert.deepEqual(handled.mock.calls.map(({ arguments: args }) => args), [['second']])
})

test('invalid responses stop new calls before cancelling in-flight uploads', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  const deadline = AbortSignal.timeout(4_000)
  const started = once(events, 'started', { signal: deadline })
  app.websocket.route('/ws/echo', {
    async onMessage(connection) {
      await started
      await connection.send('Invalid response')
    },
  })
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  const followup = once(events, 'followup', { signal: deadline })
  const upload = client.call('upload', undefined, {
    async *input(signal) {
      signal.addEventListener('abort', () => {
        client.close()
        void client.call('followup').then(
          () => events.emit('followup'),
          (error) => events.emit('followup', error),
        )
      }, { once: true })
      const cancelled = once(signal, 'abort')
      events.emit('started')
      await cancelled
    },
  })
  const pending = client.call('pending')
  const [, , [error]] = await Promise.all([
    assert.rejects(upload, { code: 'PROTOCOL_ERROR' }),
    assert.rejects(pending, { code: 'PROTOCOL_ERROR' }),
    followup,
  ])
  assert.equal(error?.code, 'NOT_OPEN')
})

test('aborting the client cancels uploads before a peer answers the close handshake', { timeout: 6_000 }, async (t) => {
  const server = new WebSocketServer({ host, port: 0 })
  t.after(async () => {
    for (const peer of server.clients) peer.terminate()
    await new Promise(resolve => server.close(resolve))
  })
  const deadline = AbortSignal.timeout(4_000)
  await once(server, 'listening', { signal: deadline })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const accepted = once(server, 'connection', { signal: deadline })
  const controller = new AbortController()
  const events = new EventEmitter()
  const opened = once(events, 'open', { signal: deadline })
  const client = connectWebSocketEndpoint(`ws://${host}:${address.port}`, {
    signal: controller.signal,
    onOpen() { events.emit('open') },
    onClose() { events.emit('close') },
  })
  t.after(() => client.close())
  await opened
  const [peer] = await accepted
  const started = once(events, 'started', { signal: deadline })
  const upload = client.call('upload', undefined, {
    async *input(signal) {
      const cancelled = once(signal, 'abort')
      events.emit('started', signal)
      await cancelled
    },
  })
  const failed = assert.rejects(upload, { code: 'DISCONNECTED' })
  const [source] = await started
  const closed = once(events, 'close', { signal: deadline })
  void closed.catch(() => {})
  peer.pause()
  controller.abort()
  assert.equal(source.aborted, true)
  await failed
  peer.resume()
  await closed
})

test('nested calls during JSON serialization keep their wire IDs in send order', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({ methods: { echo: { handle: (value) => value } } }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  /** @type {Promise<unknown> | undefined} */
  let inner
  const outer = client.call('echo', {
    toJSON() {
      inner = client.call('echo', 'nested')
      return 'outer'
    },
  })
  assert.deepEqual(await Promise.all([outer, inner]), ['outer', 'nested'])
})

test('abort during JSON serialization prevents the call from reaching the handler', { timeout: 6_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const handle = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({ methods: {
    observe: { handle },
    barrier: { handle: () => true },
  } }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  const cancelled = new AbortController()
  await assert.rejects(client.call('observe', { toJSON() { cancelled.abort(); return 'input' } }, {
    signal: cancelled.signal,
  }), { code: 'CANCELLED' })
  assert.equal(await client.call('barrier'), true)
  assert.equal(handle.mock.callCount(), 0)
})

test('a fast upload notices the server ending the call early', { timeout: 8_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    methods: {
      first: defineWebSocketMethod({
        mode: WebSocketMethodMode.ClientStream,
        async handle(_data, { input }) {
          for await (const value of input) return value
        },
      }),
    },
  }))
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  let generated = 0
  const total = 10_000
  const first = await client.call('first', undefined, {
    async *input() {
      while (generated < total) yield ++generated
    },
  })
  assert.equal(first, 1)
  assert.ok(generated < total, `producer generated ${generated} items before observing the reply`)
})

test('a completed upload drops late chunks while writing its terminal response', { timeout: 4_000 }, async (t) => {
  const events = new EventEmitter()
  const controller = new AbortController()
  t.after(() => {
    controller.abort()
    events.emit('flushed')
  })
  /** @type {import('@ainess/websocket').WebSocketConnection} */
  const connection = {
    state: undefined,
    signal: controller.signal,
    close() { controller.abort() },
    async send(message) {
      const flushed = once(events, 'flushed')
      events.emit('response', decodeWebSocketFrame(message))
      await flushed
    },
  }
  const route = defineWebSocketEndpoint({
    methods: {
      first: defineWebSocketMethod({
        mode: WebSocketMethodMode.ClientStream,
        async handle(_data, { input }) {
          const reader = input[Symbol.asyncIterator]()
          const result = await reader.next()
          events.emit('reader', reader)
          return result.value
        },
      }),
    },
  })
  const reader = once(events, 'reader', { signal: AbortSignal.timeout(2_000) })
  const response = once(events, 'response', { signal: AbortSignal.timeout(2_000) })
  route.onOpen?.(connection)
  route.onMessage?.(connection, encodeWebSocketFrame({
    type: 'call', id: '1', name: 'first', mode: WebSocketMethodMode.ClientStream,
  }))
  route.onMessage?.(connection, encodeWebSocketFrame({ type: 'chunk', id: '1', data: 'first' }))
  const [[input], [reply]] = await Promise.all([reader, response])
  assert.deepEqual(reply, { type: 'result', id: '1', data: 'first' })

  route.onMessage?.(connection, encodeWebSocketFrame({ type: 'chunk', id: '1', data: 'late' }))
  assert.deepEqual(await input.next(), { value: undefined, done: true })
})

test('a stream reads received output in order before a remote terminal error', { timeout: 7_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  app.websocket.route('/ws/echo', {
    async onMessage(connection, message) {
      const frame = decodeWebSocketFrame(message)
      assert.equal(frame.type, 'call')
      const { id } = frame
      await connection.send(encodeWebSocketFrame({ type: 'chunk', id, data: 1 }))
      await connection.send(encodeWebSocketFrame({ type: 'error', id, error: { code: 'FAILED', message: 'Failed' } }))
      await connection.send(encodeWebSocketFrame({ type: 'event', name: 'terminal' }))
    },
  })
  await app.plugin(websocketListener, { host, port: 0 }).await()
  const client = await connect(app, t)
  const events = new EventEmitter()
  const arrived = once(events, 'terminal', { signal: AbortSignal.timeout(4_000) })
  client.on('terminal', () => { events.emit('terminal') })
  const response = client.stream('partial')
  await arrived
  assert.deepEqual(await response.next(), { value: 1, done: false })
  await assert.rejects(response.next(), { code: 'FAILED' })
})

test('reconnects with fresh calls and settles the active call on disconnect', { timeout: 8_000 }, async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())
  await app.plugin(websocket).await()
  const events = new EventEmitter()
  const invoked = t.mock.fn()
  app.websocket.route('/ws/echo', defineWebSocketEndpoint({
    methods: {
      hold: {
        async handle(_data, { signal }) {
          invoked()
          const aborted = once(signal, 'abort')
          events.emit('started')
          await aborted
        },
      },
      query: { handle: () => 'ready' },
    },
  }))
  const listener = await app.plugin(websocketListener, { host, port: 0 }).await()
  const address = app.websocket.address()
  assert.ok(address)
  const signal = AbortSignal.timeout(4_000)
  const opened = once(events, 'open', { signal })
  const client = connectWebSocketEndpoint(`ws://${host}:${address.port}/ws/echo`, {
    initialDelayMs: 20,
    maxDelayMs: 80,
    onOpen() { events.emit('open') },
  })
  t.after(() => client.close())
  await opened
  const starting = once(events, 'started', { signal })
  const failed = assert.rejects(client.call('hold'), { code: 'DISCONNECTED' })
  await starting
  const reopened = once(events, 'open', { signal })
  await listener.dispose()
  await failed
  await app.plugin(websocketListener, { host, port: address.port }).await()
  await reopened
  assert.equal(await client.call('query'), 'ready')
  assert.equal(invoked.mock.callCount(), 1)
})
