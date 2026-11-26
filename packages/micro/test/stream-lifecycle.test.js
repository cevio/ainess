import assert from 'node:assert/strict'
import test from 'node:test'
import { createMicroClient } from '@ainess/micro'
import { RpcMode, RpcServer } from '@ainess/rpc'

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
  const cleared = new Set(disarm.mock.calls.map(call => call.arguments[0]))
  assert.equal(timers().filter(timer => !cleared.has(timer)).length, 0)
})
