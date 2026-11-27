import assert from 'node:assert/strict'
import test from 'node:test'
import { createMicroClient } from '@ainess/micro'
import { RpcError, RpcMode, RpcServer } from '@ainess/rpc'

test('aborting paused responses after wire completion returns shared connection credit', {
  timeout: 10_000,
}, async t => {
  const streams = 21
  const chunk = Buffer.alloc(64 * 1024)
  let completed = 0
  let allSent = () => {}
  const sent = new Promise(resolve => { allSent = () => resolve(undefined) })
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [
      { name: 'barrier', mode: RpcMode.Unary, handle: () => Buffer.alloc(0) },
      {
        name: 'events',
        mode: RpcMode.ServerStream,
        async *handle() {
          for (let frame = 0; frame < 4; frame++) yield chunk
          if (++completed === streams) allSent()
        },
      },
    ],
  })
  t.after(() => server.close())
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())

  const controllers = []
  for (let index = 0; index < streams; index++) {
    const controller = new AbortController()
    controllers.push(controller)
    const response = client.stream('orders', 'events', undefined, { signal: controller.signal, timeoutMs: 30_000 })
    t.after(() => response.return?.())
    const first = await response.next()
    assert.ok(!first.done)
    assert.equal(first.value.byteLength, chunk.byteLength)
  }
  await sent
  // The unary reply follows the buffered streams' END frames on the same connection.
  await client.request('orders', 'barrier')
  for (const controller of controllers) controller.abort()

  // The 63 unread frames would otherwise leave less than one maximum-sized frame of shared credit.
  const response = client.stream('orders', 'events', undefined, { timeoutMs: 1_000 })
  t.after(() => response.return?.())
  const first = await response.next()
  assert.ok(!first.done)
  assert.equal(first.value.byteLength, chunk.byteLength)
})

test('invalid call options leave no deadline timer behind', async t => {
  const timeoutMs = 60_017
  const arm = t.mock.method(globalThis, 'setTimeout')
  const disarm = t.mock.method(globalThis, 'clearTimeout')
  const timers = () => arm.mock.calls.filter(call => call.arguments[1] === timeoutMs).map(call => call.result)
  t.after(() => {
    for (const timer of timers()) clearTimeout(timer)
  })
  const client = createMicroClient({
    discovery: { async pick() { assert.fail('invalid options should fail before selection') } },
  })
  t.after(() => client.close())

  /** @type {AbortSignal} */
  const signal = JSON.parse('{}')
  await assert.rejects(client.request('orders', 'events', undefined, { signal, timeoutMs }), TypeError)
  const failure = new Error('input getter failed')
  await assert.rejects(client.request('orders', 'events', undefined, {
    timeoutMs,
    /** @returns {never} */
    get input() { throw failure },
  }), failure)
  await assert.rejects(client.stream('orders', 'events', undefined, {
    timeoutMs,
    firstResponseTimeoutMs: 0,
  }).next(), RangeError)
  await assert.rejects(client.stream('orders', 'events', undefined, {
    timeoutMs,
    firstResponseTimeoutMs: timeoutMs,
    readIdleTimeoutMs: 0,
  }).next(), RangeError)
  const cleared = new Set(disarm.mock.calls.map(call => call.arguments[0]))
  assert.equal(timers().filter(timer => !cleared.has(timer)).length, 0)
})

test('cancellation in a failure observer preserves an upload exception with an unreadable code', {
  timeout: 5_000,
}, async t => {
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [{
      name: 'upload',
      mode: RpcMode.ClientStream,
      async handle({ input }) {
        for await (const chunk of input) return chunk
        return Buffer.alloc(0)
      },
    }, {
      name: 'echo',
      mode: RpcMode.Unary,
      handle: ({ data }) => data,
    }],
  })
  t.after(() => server.close())
  const client = createMicroClient({ discovery: { async pick() { return server.address } } })
  t.after(() => client.close())

  const caller = new AbortController()
  const failure = Object.defineProperty(new RpcError('INTERNAL', 'upload failed'), 'code', {
    get() { throw new Error('unreadable code') },
  })
  await assert.rejects(client.request('orders', 'upload', undefined, {
    signal: caller.signal,
    input() { throw failure },
    onFailure() { caller.abort() },
  }), error => error === failure)
  assert.equal(caller.signal.aborted, true)
  assert.deepEqual(await client.request('orders', 'echo', Buffer.from('next')), Buffer.from('next'))
})
