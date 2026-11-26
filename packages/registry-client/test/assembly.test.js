import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { defineApp, use } from '@ainess/framework'
import { registry } from '@ainess/registry-client'
import { registryServer } from '@ainess/registry-server'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

test('Cordis applications discover and call a service over TCP, then remove its registration on stop', {
  timeout: 10_000,
}, async (t) => {
  /** @type {Array<() => Promise<void>>} */
  const cleanup = []
  t.after(async () => {
    for (const close of cleanup.reverse()) await close()
  })

  const host = '127.0.0.1'
  const directory = await defineApp({
    entries: { registryServer: use(registryServer, { host, port: 0 }) },
  }).start()
  cleanup.push(directory.stop)

  const address = directory.ctx.registryServer.address
  const query = { service: 'orders' }
  const provider = await defineApp({
    plugins: { registry: use(registry, { address }) },
    entries: {
      orders: use({
        inject: ['registryClient'],
        /** @param {import('@deepseek-ai/cordis').Context} ctx */
        async apply(ctx) {
          await ctx.effect(async () => {
            const server = await RpcServer.listen({
              host,
              port: 0,
              methods: [{
                name: 'orders.health',
                mode: RpcMode.Unary,
                handle: () => new TextEncoder().encode('ready'),
              }],
            })
            try {
              const reply = await ctx.registryClient.discovery.register({
                ...server.address,
                services: ['orders', 'refunds'],
              })
              assert.deepEqual(reply, { registered: ['orders', 'refunds'] })
            } catch (error) {
              await server.close()
              throw error
            }
            return () => server.close()
          })
        },
      }),
    },
  }).start()
  cleanup.push(provider.stop)

  const consumer = await defineApp({ plugins: { registry: use(registry, { address }) } }).start()
  cleanup.push(consumer.stop)
  const providerClient = provider.ctx.registryClient
  const discovery = consumer.ctx.registryClient.discovery
  const picked = await discovery.pick(query)
  assert.ok(picked)
  assert.deepEqual(await discovery.list(query), [picked])
  assert.deepEqual(await discovery.list({ service: 'refunds' }), [picked])
  const exclude = [picked]
  assert.equal(await discovery.pick({ ...query, exclude }), null)
  assert.deepEqual(await discovery.pick(query), picked)

  const peer = await RpcPeer.connect(picked)
  try {
    const reply = await peer.request('orders.health', { timeoutMs: 5_000 })
    assert.equal(new TextDecoder().decode(reply), 'ready')
  } finally {
    await peer.close()
  }

  await provider.stop()
  assert.equal(providerClient.state, 'closed')
  const deadline = AbortSignal.timeout(2_000)
  while ((await discovery.list(query)).length) await delay(10, undefined, { signal: deadline })
  assert.equal(await discovery.pick(query), null)
  assert.deepEqual(await discovery.list({ service: 'refunds' }), [])
})
