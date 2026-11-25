import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { RpcError, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'
import { deferred } from '../dist/deferred.js'

test('registration snapshots an inherited handler and preserves its receiver', { timeout: 5_000 }, async t => {
  class Counter {
    name = 'counter'

    /** @type {RpcMode.Unary} */
    mode = RpcMode.Unary

    reads = 0
    #count = 0

    get handle() {
      this.reads++
      return this.increment
    }

    /** @param {import('@ainess/rpc').RpcCall} call */
    increment({ data }) {
      return Buffer.from(`${++this.#count}:${Buffer.from(data).toString()}`)
    }
  }

  const method = new Counter()
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0, methods: [method] })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address)
  t.after(() => client.close())

  method.name = 'renamed'
  assert.equal(Buffer.from(await client.request('counter', Buffer.from('first'))).toString(), '1:first')
  assert.equal(Buffer.from(await client.request('counter', Buffer.from('second'))).toString(), '2:second')
  assert.equal(method.reads, 1)
})

test('an unreadable handler error is reported without interrupting other calls', { timeout: 5_000 }, async t => {
  const error = new RpcError('INVALID_ARGUMENT')
  Object.defineProperty(error, 'message', {
    get() { throw new Error('message accessor failed') },
  })
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [
      { name: 'fail', mode: RpcMode.Unary, handle() { throw error } },
      { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    ],
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address)
  t.after(() => client.close())

  await assert.rejects(client.request('fail', { timeoutMs: 1_000 }), {
    code: 'INVALID_ARGUMENT', message: 'RPC handler failed',
  })
  assert.equal(Buffer.from(await client.request('echo', Buffer.from('ok'))).toString(), 'ok')
})

test('retained unregister functions do not keep removed handlers alive', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/method-retention.mjs', import.meta.url))
  await promisify(execFile)(process.execPath, ['--expose-gc', fixture], { timeout: 5_000 })
})

test('registration rejects when reading its method closes the owner', { timeout: 5_000 }, async t => {
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  const peer = await RpcPeer.connect(server.address)
  t.after(() => peer.close())

  for (const owner of [peer, server]) {
    assert.throws(() => owner.register({
      get name() {
        void owner.close()
        return 'too-late'
      },
      mode: RpcMode.Unary,
      handle: ({ data }) => data,
    }), { code: 'UNAVAILABLE' })
    await owner.close()
  }
})

test('handler metadata cannot replace a competing registration for the same name', { timeout: 5_000 }, async t => {
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address)
  t.after(() => client.close())

  let metadataReads = 0
  const handle = () => Buffer.from('outer')
  Object.defineProperty(handle, 'name', {
    get() {
      metadataReads++
      server.register({
        name: 'race',
        mode: RpcMode.Unary,
        handle: () => Buffer.from('inner'),
      })
      return 'handle'
    },
  })
  assert.throws(() => server.register({ name: 'race', mode: RpcMode.Unary, handle }), { code: 'INVALID_ARGUMENT' })
  assert.equal(metadataReads, 1)
  assert.throws(() => server.register({ name: 'race', mode: RpcMode.Unary, handle }), { code: 'INVALID_ARGUMENT' })
  assert.equal(metadataReads, 1)
  assert.equal(Buffer.from(await client.request('race')).toString(), 'inner')
})

test('unregister still waits for accepted work after the listener closes', { timeout: 5_000 }, async t => {
  const entered = deferred()
  const cleanup = deferred()
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => {
    cleanup.resolve(undefined)
    return server.close()
  })
  const unregister = server.register({
    name: 'pending',
    mode: RpcMode.Unary,
    async handle() {
      entered.resolve(undefined)
      await cleanup.promise
      return new Uint8Array()
    },
  })
  const client = await RpcPeer.connect(server.address)
  t.after(() => client.close())

  const call = assert.rejects(client.request('pending'), { code: 'UNAVAILABLE' })
  await entered.promise
  await server.close()
  await call

  const drained = unregister()
  assert.equal(unregister(), drained)
  let settled = false
  void drained.then(() => { settled = true })
  await setImmediate()
  assert.equal(settled, false)
  cleanup.resolve(undefined)
  await drained
})
