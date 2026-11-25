import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

async function removeMethods() {
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0 })
  try {
    const peer = await RpcPeer.connect(server.address)
    const records = []
    for (const owner of [server, peer]) {
      for (const scenario of ['control', 'unregistered', 'owner-closed']) {
        const data = new Uint8Array(16)
        const remove = owner.register({ name: scenario, mode: RpcMode.Unary, handle: () => data })
        records.push({ scenario, ref: new WeakRef(data), remove: scenario === 'control' ? undefined : remove })
        if (scenario !== 'owner-closed') await remove()
      }
    }
    return records
  } finally {
    await server.close()
  }
}

const collectGarbage = globalThis.gc
assert.ok(collectGarbage, 'Run this fixture with --expose-gc')
const records = await removeMethods()
for (let attempt = 0; attempt < 8; attempt++) {
  await setImmediate()
  collectGarbage()
}

const retained = records.filter(({ ref }) => ref.deref()).map(({ scenario }) => scenario)
for (const { remove } of records) await remove?.()
assert.deepEqual(retained, [], 'Removed handlers should be collectible while their unregister functions are retained')
