import assert from 'node:assert/strict'
import { Socket } from 'node:net'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { RegistryClient } from '@ainess/registry-client'
import { RegistryServer } from '@ainess/registry-server'

/** @param {() => boolean} predicate */
async function waitFor(predicate) {
  const signal = AbortSignal.timeout(5_000)
  while (!predicate()) await delay(10, undefined, { signal })
}

test('a fresh registry rebuilds registrations across frames and omits offline withdrawals', {
  timeout: 15_000,
}, async (t) => {
  const keepAlive = t.mock.method(Socket.prototype, 'setKeepAlive')
  const directory = await RegistryServer.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => directory.close())
  const address = directory.address
  const publisher = await RegistryClient.connect(address)
  t.after(() => publisher.close())
  const observer = await RegistryClient.connect(address)
  t.after(() => observer.close())

  function assertControlKeepAlive() {
    const calls = keepAlive.mock.calls
    assert.equal(calls.length, 4)
    assert.equal(calls.filter(call => /** @type {Socket} */ (call.this).localPort === address.port).length, 2)
    assert.equal(calls.filter(call => /** @type {Socket} */ (call.this).remotePort === address.port).length, 2)
    for (const call of calls) assert.deepEqual(call.arguments, [true, 5_000])
    keepAlive.mock.resetCalls()
  }

  assertControlKeepAlive()
  const endpoint = { host: '127.0.0.1', port: 7001 }
  const services = Array.from({ length: 800 }, (_, index) => `com.example.${index}.${'配'.repeat(40)}`)
  await publisher.discovery.register({ ...endpoint, services: ['orders', 'refunds', ...services.slice(0, 400)] })
  await publisher.discovery.register({ ...endpoint, services: services.slice(400) })
  assert.deepEqual(await observer.discovery.list({ service: 'refunds' }), [endpoint])

  await directory.close()
  await waitFor(() => publisher.state === 'reconnecting' && observer.state === 'reconnecting')
  await publisher.discovery.unregister({ ...endpoint, services: ['refunds'] })
  const restarted = await RegistryServer.listen(address)
  t.after(() => restarted.close())
  await waitFor(() => publisher.state === 'ready' && observer.state === 'ready')
  assertControlKeepAlive()

  assert.deepEqual(await observer.discovery.list({ service: 'orders' }), [endpoint])
  assert.deepEqual(await observer.discovery.list({ service: services[0] }), [endpoint])
  assert.deepEqual(await observer.discovery.list({ service: services[799] }), [endpoint])
  assert.deepEqual(await observer.discovery.list({ service: 'refunds' }), [])

  await publisher.discovery.unregister({ ...endpoint, services })
  assert.deepEqual(await observer.discovery.list({ service: 'orders' }), [endpoint])
  assert.deepEqual(await observer.discovery.list({ service: services[0] }), [])
  assert.deepEqual(await observer.discovery.list({ service: services[799] }), [])
})
