import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcError, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

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
