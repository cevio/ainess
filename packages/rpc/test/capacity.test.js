import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:net'
import test from 'node:test'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

function latch() {
  let release = () => {}
  const promise = new Promise(resolve => { release = () => resolve(undefined) })
  return { promise, resolve: release }
}

test('negotiates more than 256 simultaneous calls on one TCP connection', { timeout: 5_000 }, async t => {
  const count = 320
  const entered = latch()
  const release = latch()
  let started = 0
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    maxConcurrentCalls: 384,
    methods: [{
      name: 'echo', mode: RpcMode.Unary,
      async handle({ data }) {
        if (++started === count) entered.resolve()
        await release.promise
        return data
      },
    }],
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address, { maxConcurrentCalls: 384 })
  t.after(() => client.close())

  const inputs = Array.from({ length: count }, (_, index) => Buffer.from(String(index)))
  const results = Promise.all(inputs.map(input => client.request('echo', input)))
  try {
    await Promise.race([entered.promise, results])
    assert.equal(started, count)
  } finally {
    release.resolve()
  }
  assert.deepEqual((await results).map(result => Buffer.from(result)), inputs)
})

test('uses the lower negotiated limit independently in both directions', { timeout: 5_000 }, async t => {
  const limit = 3
  const entered = latch()
  const release = latch()
  const ready = latch()
  let started = 0
  /** @type {RpcPeer | undefined} */
  let accepted
  /** @type {import('@ainess/rpc').RpcMethod} */
  const method = {
    name: 'echo', mode: RpcMode.Unary,
    async handle({ data }) {
      if (++started === limit * 2) entered.resolve()
      await release.promise
      return data
    },
  }
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    maxConcurrentCalls: limit,
    methods: [method],
    onPeer(peer) {
      accepted = peer
      ready.resolve()
    },
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address, { maxConcurrentCalls: 384, methods: [method] })
  t.after(() => client.close())
  await ready.promise
  assert.ok(accepted)

  const payload = Buffer.from('ok')
  const peers = [client, accepted]
  const results = Promise.all(peers.flatMap(peer =>
    Array.from({ length: limit }, () => peer.request('echo', payload))))
  try {
    await Promise.race([entered.promise, results])
    assert.equal(started, limit * 2)
    await Promise.all(peers.map(peer => assert.rejects(peer.request('echo', { timeoutMs: 250 }), {
      code: 'RESOURCE_EXHAUSTED',
    })))
  } finally {
    release.resolve()
  }
  assert.deepEqual((await results).map(result => Buffer.from(result)), Array(limit * 2).fill(payload))
  const reused = await Promise.all(peers.map(peer => peer.request('echo', payload)))
  assert.deepEqual(reused.map(result => Buffer.from(result)), [payload, payload])
})

test('an upload abort listener can immediately reuse the only call slot', { timeout: 5_000 }, async t => {
  const receiving = latch()
  const uploading = latch()
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    maxConcurrentCalls: 1,
    methods: [
      {
        name: 'upload',
        mode: RpcMode.ClientStream,
        async handle({ input }) {
          receiving.resolve()
          for await (const chunk of input) void chunk
          return Buffer.alloc(0)
        },
      },
      { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    ],
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address, { maxConcurrentCalls: 1 })
  t.after(() => client.close())
  const controller = new AbortController()
  const payload = Buffer.from('reused')
  /** @type {Promise<Uint8Array> | undefined} */
  let replacement

  const cancelled = assert.rejects(client.request('upload', {
    signal: controller.signal,
    input: async function* (signal) {
      signal.addEventListener('abort', () => {
        replacement = client.request('echo', payload)
        void replacement.catch(() => {})
      }, { once: true })
      uploading.resolve()
      await once(signal, 'abort')
    },
  }), { code: 'CANCELLED' })

  await Promise.all([receiving.promise, uploading.promise])
  controller.abort()
  assert.ok(replacement)
  const [, echoed] = await Promise.all([cancelled, replacement])
  assert.deepEqual(Buffer.from(echoed), payload)
})

test('rejects invalid call limits before connecting or binding', { timeout: 5_000 }, async t => {
  let accepted = 0
  const occupied = createServer(socket => {
    accepted++
    socket.destroy()
  })
  occupied.listen(0, '127.0.0.1')
  await once(occupied, 'listening')
  t.after(() => new Promise(resolve => occupied.close(() => resolve(undefined))))
  const address = occupied.address()
  assert.ok(address && typeof address !== 'string')
  const endpoint = { host: '127.0.0.1', port: address.port }

  for (const maxConcurrentCalls of [-1, 0, 1.5, 4097, NaN, Infinity]) {
    await assert.rejects(RpcPeer.connect(endpoint, { maxConcurrentCalls }), { code: 'INVALID_ARGUMENT' })
    await assert.rejects(RpcServer.listen({ ...endpoint, maxConcurrentCalls }), { code: 'INVALID_ARGUMENT' })
  }
  assert.equal(accepted, 0)
})
