import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { RpcError, RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

async function closePeers() {
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    methods: [{
      name: 'events',
      mode: RpcMode.ServerStream,
      async *handle() { yield Buffer.from('event') },
    }],
  })
  const records = []
  try {
    for (const scenario of ['unstarted', 'returned', 'exhausted', 'failed']) {
      const peer = await RpcPeer.connect(server.address)
      const output = peer.stream(scenario === 'failed' ? '' : 'events')
      if (scenario === 'returned') assert.equal((await output.next()).done, false)
      if (scenario === 'unstarted' || scenario === 'returned') await output.return?.()
      if (scenario === 'exhausted') for await (const chunk of output) assert.equal(chunk.byteLength, 5)
      if (scenario === 'failed') {
        await assert.rejects(output.next(), error => {
          assert.ok(error instanceof RpcError)
          // Materialize the stack so the runtime does not retain its calling contexts.
          void error.stack
          return error.code === 'INVALID_ARGUMENT'
        })
      }
      const ref = new WeakRef(peer)
      await peer.close()
      records.push({ scenario, ref, output })
    }
  } finally {
    await server.close()
  }
  return records
}

const collectGarbage = globalThis.gc
assert.ok(collectGarbage, 'Run this fixture with --expose-gc')
const records = await closePeers()
for (let attempt = 0; attempt < 8; attempt++) {
  await setImmediate()
  collectGarbage()
}

const retained = records.filter(({ ref }) => ref.deref()).map(({ scenario }) => scenario)
for (const { scenario, output } of records) {
  if (scenario === 'failed') await assert.rejects(output.next(), { code: 'INVALID_ARGUMENT' })
  else assert.equal((await output.next()).done, true)
}
assert.deepEqual(retained, [], 'The closed peers should be collectible while their terminal iterators are retained')
