import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { RpcPeer, RpcServer } from '@ainess/rpc'

async function closePeers() {
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0 })
  const records = []
  try {
    for (const scenario of ['control', 'notified', 'unsubscribed', 'late']) {
      const peer = await RpcPeer.connect(server.address)
      const ref = new WeakRef(peer)
      let unsubscribe
      if (scenario === 'notified' || scenario === 'unsubscribed') {
        unsubscribe = peer.onClose(() => {})
        if (scenario === 'unsubscribed') unsubscribe()
      }
      await peer.close()
      if (scenario === 'late') unsubscribe = peer.onClose(() => {})
      records.push({ scenario, ref, unsubscribe })
    }
  } finally {
    await server.close()
  }
  return records
}

const collectGarbage = globalThis.gc
assert.ok(collectGarbage, 'Run this fixture with --expose-gc')
const records = await closePeers()
// Leave the peer creation frame and allow pending socket and listener work to finish.
for (let attempt = 0; attempt < 8; attempt++) {
  await setImmediate()
  collectGarbage()
}

const retained = records.filter(({ ref }) => ref.deref()).map(({ scenario }) => scenario)
// Use the disposers after collection so they remain reachable during every GC attempt.
for (const { unsubscribe } of records) unsubscribe?.()
assert.deepEqual(retained, [], 'The closed peers should be collectible while their disposers are retained')
