import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

function latch() {
  let release = () => {}
  const promise = new Promise(resolve => { release = () => resolve(undefined) })
  return { promise, resolve: release }
}

test('admits more than 4096 simultaneous calls in each direction on one TCP connection', {
  timeout: 10_000,
}, async t => {
  const count = 4_608
  const entered = latch()
  const release = latch()
  const ready = latch()
  let started = 0
  /** @type {RpcPeer | undefined} */
  let accepted
  /** @type {import('@ainess/rpc').RpcMethod} */
  const method = {
    name: 'echo',
    mode: RpcMode.Unary,
    async handle({ data }) {
      if (++started === count * 2) entered.resolve()
      await release.promise
      return data
    },
  }
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [method],
    onPeer(peer) {
      accepted = peer
      ready.resolve()
    },
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address, { methods: [method] })
  t.after(() => client.close())
  await ready.promise
  assert.ok(accepted)

  const inputs = Array.from({ length: count }, (_, index) => Buffer.from(index % 2 === 0 ? '' : String(index)))
  const remote = accepted
  const peers = [client, remote]
  const firstIdBudgets = [0x80000000, 0x7fffffff]
  assert.deepEqual(peers.map(peer => peer.remainingOutgoingCallIds), firstIdBudgets)
  const results = Promise.all(peers.flatMap(peer => inputs.map(input => peer.request('echo', input))))
  try {
    await Promise.race([entered.promise, results])
    assert.equal(started, count * 2)
  } finally {
    release.resolve()
  }
  assert.deepEqual((await results).map(result => Buffer.from(result)), [...inputs, ...inputs])
  const reply = Buffer.from('peer still usable')
  assert.deepEqual(
    (await Promise.all(peers.map(peer => peer.request('echo', reply)))).map(result => Buffer.from(result)),
    [reply, reply],
  )
  assert.deepEqual(peers.map(peer => peer.remainingOutgoingCallIds), firstIdBudgets.map(budget => budget - count - 1))

  const remoteClose = new Promise(resolve => remote.onClose(resolve))
  const closing = client.close()
  assert.equal(client.remainingOutgoingCallIds, 0)
  await Promise.all([closing, remoteClose])
  assert.equal(remote.remainingOutgoingCallIds, 0)
})

test('full-duplex uploads leave connection credit for streaming replies', { timeout: 8_000 }, async t => {
  const ready = latch()
  /** @type {RpcPeer | undefined} */
  let accepted
  /** @type {import('@ainess/rpc').RpcMethod} */
  const echo = {
    name: 'bidi.echo',
    mode: RpcMode.Bidi,
    async *handle({ input }) { for await (const bytes of input) yield bytes },
  }
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [echo],
    onPeer(peer) {
      accepted = peer
      ready.resolve()
    },
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address, { methods: [echo] })
  t.after(() => client.close())
  await ready.promise
  assert.ok(accepted)

  const inputs = [0, 17, 4_096, 61_440, 65_536].map((size, index) => Buffer.alloc(size, index + 1))
  const peers = [client, accepted]
  await Promise.all(Array.from({ length: 240 }, async (_, index) => {
    const output = peers[index % 2].stream(echo.name, {
      async *input() { yield* inputs },
      timeoutMs: 3_000,
    })
    let received = 0
    for await (const chunk of output) assert.deepEqual(Buffer.from(chunk), inputs[received++])
    assert.equal(received, inputs.length)
  }))
})

test('an upload abort listener can immediately start another call on the same peer', { timeout: 5_000 }, async t => {
  const receiving = latch()
  const uploading = latch()
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
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
  const client = await RpcPeer.connect(server.address)
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

test('returning a response iterator during lazy startup leaves the connection usable', { timeout: 5_000 }, async t => {
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [
      {
        name: 'events', mode: RpcMode.ServerStream,
        async *handle({ signal }) {
          if (!signal.aborted) await once(signal, 'abort')
        },
      },
      { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    ],
  })
  t.after(() => server.close())
  const client = await RpcPeer.connect(server.address)
  t.after(() => client.close())
  const output = client.stream('events', {
    get timeoutMs() {
      void output.return?.()
      return 2_000
    },
  })

  assert.equal((await output.next()).done, true)
  const payload = Buffer.from('connection still usable')
  assert.deepEqual(Buffer.from(await client.request('echo', payload)), payload)
})
