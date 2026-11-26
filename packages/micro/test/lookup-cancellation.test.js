import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { setImmediate as yieldToIO, setTimeout as delay } from 'node:timers/promises'
import { createMicroClient } from '@ainess/micro'
import { RegistryClient } from '@ainess/registry-client'
import { RpcMode, RpcServer } from '@ainess/rpc'
import { deferred } from '../../rpc/dist/deferred.js'

for (const abortBy of ['deadline', 'close']) {
  test(`shared lookup ${abortBy} works when discovery stops abort event propagation`, {
    timeout: 5_000,
  }, async t => {
    const started = deferred()
    const aborted = deferred()
    /** @type {import('../../rpc/dist/deferred.js').Deferred<null>} */
    const lookup = deferred()
    const micro = createMicroClient({
      connectTimeoutMs: abortBy === 'deadline' ? 40 : 30_000,
      discovery: {
        pick(_query, { signal } = {}) {
          assert.ok(signal)
          signal.addEventListener('abort', event => {
            event.stopImmediatePropagation()
            aborted.resolve(undefined)
          }, { once: true })
          started.resolve(undefined)
          return lookup.promise
        },
      },
    })
    t.after(async () => {
      lookup.resolve(null)
      await micro.close()
    })

    const pending = assert.rejects(micro.request('orders', 'echo'), { code: 'UNAVAILABLE' })
    await started.promise
    // The production deadline is unref'ed, so keep a deadline for the test itself.
    const watchdog = setTimeout(() => aborted.reject(new Error('Discovery did not observe cancellation')), 2_000)
    t.after(() => clearTimeout(watchdog))
    const finished = abortBy === 'close' ? Promise.all([pending, micro.close()]) : pending
    await aborted.promise
    assert.equal(await Promise.race([finished.then(() => true), yieldToIO(false)]), true)
  })
}

test('a shared lookup deadline cancels the Registry RPC before the next wave', { timeout: 5_000 }, async (t) => {
  /** @type {unknown[]} */
  const queries = []
  let connections = 0
  let inFlight = 0
  let peak = 0
  const registry = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    onPeer: () => { connections++ },
    methods: [{
      name: 'registry.discovery.pick',
      mode: RpcMode.Unary,
      async handle({ data, signal }) {
        const query = JSON.parse(Buffer.from(data).toString())
        if (query.service === 'other') return Buffer.from('null')
        queries.push(query)
        inFlight++
        peak = Math.max(peak, inFlight)
        try {
          if (!signal.aborted) await once(signal, 'abort')
          return Buffer.from('null')
        } finally {
          inFlight--
        }
      },
    }],
  })
  const registryClient = await RegistryClient.connect(registry.address, { timeoutMs: 4_000 })
  const micro = createMicroClient({
    discovery: registryClient.discovery,
    connectTimeoutMs: 40,
    timeoutMs: 4_000,
  })
  t.after(async () => {
    await micro.close()
    await registryClient.close()
    await registry.close()
  })

  const wave = () => Promise.all(Array.from({ length: 100 }, () =>
    assert.rejects(micro.request('orders', 'echo'), { code: 'UNAVAILABLE' })))
  await wave()
  await delay(220)
  await wave()

  assert.deepEqual(queries, [{ service: 'orders' }, { service: 'orders' }])
  assert.equal(peak, 1)
  await micro.close()
  assert.equal(await registryClient.discovery.pick({ service: 'other' }), null)
  assert.equal(inFlight, 0)
  assert.equal(connections, 1)
})
