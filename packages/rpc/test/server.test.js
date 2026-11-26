import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { Server } from 'node:net'
import test from 'node:test'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

const address = { host: '127.0.0.1', port: 0 }

test('a pre-aborted signal prevents RPC from starting a TCP listener', { timeout: 5_000 }, async (t) => {
  const listen = t.mock.method(Server.prototype, 'listen')
  const controller = new AbortController()
  controller.abort()
  const started = RpcServer.listen({ ...address, signal: controller.signal })
  t.after(async () => { await (await started.catch(() => undefined))?.close() })

  await assert.rejects(started, { code: 'CANCELLED' })
  assert.equal(listen.mock.callCount(), 0)
})

test('the startup signal detaches once the RPC server is listening', { timeout: 5_000 }, async (t) => {
  const controller = new AbortController()
  const server = await RpcServer.listen({
    ...address,
    signal: controller.signal,
    methods: [{ name: 'ping', mode: RpcMode.Unary, handle: () => Buffer.from('pong') }],
  })
  t.after(() => server.close())
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  controller.abort()

  const peer = await RpcPeer.connect(server.address)
  t.after(() => peer.close())
  assert.equal(Buffer.from(await peer.request('ping', { timeoutMs: 1_000 })).toString(), 'pong')
})

test('a TCP bind failure preserves the native error with a startup signal', { timeout: 5_000 }, async (t) => {
  const occupied = await RpcServer.listen(address)
  t.after(() => occupied.close())

  const { signal } = new AbortController()
  await assert.rejects(RpcServer.listen({ ...occupied.address, signal }), { code: 'EADDRINUSE' })
  assert.equal(getEventListeners(signal, 'abort').length, 0)
})
