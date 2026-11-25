import assert from 'node:assert/strict'
import { getEventListeners, once } from 'node:events'
import test from 'node:test'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'
import { deferred } from '../dist/deferred.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {number} limit
 * @param {import('@ainess/rpc').RpcMethod[]} [methods]
 */
async function connect(t, limit, methods = []) {
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    maxConcurrentCalls: limit,
    methods: [{ name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data }, ...methods],
  })
  t.after(() => server.close())
  const peer = await RpcPeer.connect(server.address)
  t.after(() => peer.close())
  return peer
}

for (const limit of [1, 2]) {
  test(`abort signal registration safely re-enters with capacity ${limit}`, { timeout: 5_000 }, async t => {
    const peer = await connect(t, limit)
    const { signal } = new AbortController()
    const add = signal.addEventListener
    /** @type {Promise<Uint8Array> | undefined} */
    let nested
    t.mock.method(signal, 'addEventListener', function () {
      nested = peer.request('echo', Buffer.from('nested'))
      return Reflect.apply(add, signal, arguments)
    })

    const reply = peer.request('echo', Buffer.from('outer'), { signal })
    assert.ok(nested)
    if (limit === 1) await assert.rejects(reply, { code: 'RESOURCE_EXHAUSTED' })
    else assert.equal(String(await reply), 'outer')
    assert.equal(String(await nested), 'nested')
    assert.equal(getEventListeners(signal, 'abort').length, 0)
  })
}

test('aborting while registering the signal prevents the call from opening', { timeout: 5_000 }, async t => {
  let calls = 0
  const peer = await connect(t, 1, [{
    name: 'count', mode: RpcMode.Unary,
    handle() {
      calls++
      return Buffer.alloc(0)
    },
  }])
  const controller = new AbortController()
  const { signal } = controller
  const add = signal.addEventListener
  t.mock.method(signal, 'addEventListener', function () {
    Reflect.apply(add, signal, arguments)
    controller.abort()
  })

  await assert.rejects(peer.request('count', { signal }), { code: 'CANCELLED' })
  await peer.request('echo')
  assert.equal(calls, 0)
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})

test('a registration error removes the listener and preserves the call slot', { timeout: 5_000 }, async t => {
  const peer = await connect(t, 1)
  const { signal } = new AbortController()
  const add = signal.addEventListener
  const failure = new Error('Abort listener tracing failed')
  t.mock.method(signal, 'addEventListener', function () {
    Reflect.apply(add, signal, arguments)
    throw failure
  })

  await assert.rejects(peer.request('echo', { signal }), error => error === failure)
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  const payload = Buffer.from('slot available')
  assert.deepEqual(await peer.request('echo', payload), payload)
})

test('abort signal disposal can reopen the only call slot after cancellation', { timeout: 5_000 }, async t => {
  /** @type {import('../dist/deferred.js').Deferred<void>} */
  const started = deferred()
  const peer = await connect(t, 1, [{
    name: 'wait', mode: RpcMode.Unary,
    async handle({ signal }) {
      started.resolve(undefined)
      if (!signal.aborted) await once(signal, 'abort')
      return Buffer.alloc(0)
    },
  }])
  const controller = new AbortController()
  const { signal } = controller
  const remove = signal.removeEventListener
  /** @type {Promise<Uint8Array> | undefined} */
  let reopened
  t.mock.method(signal, 'removeEventListener', function () {
    reopened = peer.request('echo', Buffer.from('reopened'))
    void reopened.catch(() => {})
    return Reflect.apply(remove, signal, arguments)
  })

  const waiting = assert.rejects(peer.request('wait', { signal }), { code: 'CANCELLED' })
  await started.promise
  controller.abort()
  await waiting
  assert.ok(reopened)
  assert.equal(String(await reopened), 'reopened')
})

test('abort signal removal errors do not strand a completed call', { timeout: 5_000 }, async t => {
  const peer = await connect(t, 1)
  const { signal } = new AbortController()
  t.mock.method(signal, 'removeEventListener', () => {
    throw new Error('Abort listener tracing failed')
  })
  const closed = new Promise(resolve => { peer.onClose(resolve) })
  const payload = Buffer.from('completed')

  assert.deepEqual(await Promise.race([peer.request('echo', payload, { signal }), closed]), payload)
  assert.deepEqual(await peer.request('echo', payload), payload)
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})

test('a reused abort signal accumulates no listeners when its removal hook is a no-op', { timeout: 5_000 }, async t => {
  const peer = await connect(t, 1)
  const { signal } = new AbortController()
  t.mock.method(signal, 'removeEventListener', () => {})
  const payload = Buffer.from('completed')

  for (let index = 0; index < 3; index++) {
    assert.deepEqual(await peer.request('echo', payload, { signal }), payload)
    assert.equal(getEventListeners(signal, 'abort').length, 0)
  }
})
