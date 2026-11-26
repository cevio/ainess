import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeRegistryMessage,
  encodeRegistryListBatches,
  encodeRegistryMessage,
  encodeRegistryRegistration,
  encodeRegistryRegistrationBatches,
  parsePickQuery,
  parseRegistration,
  parseRegisterResponse,
  parseRegistryListBatch,
  parseRegistryPickResponse,
  parseServiceQuery,
  parseUnregisterResponse,
  registryAddressKey,
  registryMethods,
} from '@ainess/registry-shared'

test('the discovery method names and payload shapes are shared by both peers', () => {
  assert.deepEqual(registryMethods, {
    register: 'registry.discovery.register',
    unregister: 'registry.discovery.unregister',
    list: 'registry.discovery.list',
    pick: 'registry.discovery.pick',
  })
  const address = { host: '::1', port: 7001 }
  const registration = { ...address, services: ['订单', 'refunds', '订单'] }
  const data = encodeRegistryRegistration(registration)
  assert.deepEqual(parseRegistration(decodeRegistryMessage(data)), { ...address, services: ['订单', 'refunds'] })
  assert.deepEqual(parseServiceQuery({ service: '订单' }), { service: '订单' })
  assert.deepEqual(parseRegisterResponse({ registered: ['订单'] }), { registered: ['订单'] })
  assert.deepEqual(parseUnregisterResponse({ removed: ['refunds'] }), { removed: ['refunds'] })
  assert.deepEqual(parseRegistryPickResponse(address), address)
  assert.equal(parseRegistryPickResponse(null), null)
  assert.notEqual(registryAddressKey(address), registryAddressKey({ ...address, port: 7002 }))
})

test('invalid discovery messages are rejected before use', () => {
  for (const value of [
    null,
    { host: '127.0.0.1', port: 0, services: ['orders'] },
    { host: '127.0.0.1', port: 7001, services: ['orders', 1] },
    { host: '', port: 7001, services: ['orders'] },
  ]) {
    assert.throws(() => parseRegistration(value), TypeError)
  }
  assert.throws(() => parseServiceQuery(Object.create({ service: 'orders' })), TypeError)
  assert.throws(() => parseRegistryListBatch([{ host: '127.0.0.1', port: '7001' }]), TypeError)
  assert.throws(() => decodeRegistryMessage(Uint8Array.of(0xff)), TypeError)
  assert.throws(() => decodeRegistryMessage(encodeRegistryMessage('[]').subarray(0, 2)), TypeError)
})

test('pick queries accept optional exclusions using the registration address shape', () => {
  const query = { service: '订单' }
  const address = { host: '::1', port: 7001 }
  assert.deepEqual(parsePickQuery(query), query)
  assert.deepEqual(parsePickQuery({ ...query, exclude: [] }), { ...query, exclude: [] })
  assert.deepEqual(parsePickQuery({ ...query, exclude: [address] }), { ...query, exclude: [address] })

  for (const exclude of [null, address, [null], [{ ...address, host: ' ' }], [{ ...address, port: '7001' }]]) {
    assert.throws(() => parsePickQuery({ ...query, exclude }), TypeError)
  }
})

test('large recovery and list snapshots span RPC frames without losing items', () => {
  const services = Array.from({ length: 700 }, (_, index) => `订单."${index}.${'配'.repeat(40)}`)
  const registration = { host: '127.0.0.1', port: 7001, services }
  assert.throws(() => encodeRegistryRegistration(registration), /bytes/)
  const requests = [...encodeRegistryRegistrationBatches(registration)]
  assert.ok(requests.length > 1)
  assert.ok(requests.every(({ data }) => data.byteLength <= 65535 - registryMethods.unregister.length))
  for (const request of requests) {
    assert.deepEqual(parseRegistration(decodeRegistryMessage(request.data)).services, request.services)
  }
  assert.deepEqual(requests.flatMap((request) => request.services), services)

  const addresses = Array.from({ length: 3_000 }, (_, index) => ({ host: '127.0.0.1', port: 1 + index }))
  const batches = [...encodeRegistryListBatches(addresses)]
  assert.ok(batches.length > 1)
  assert.ok(batches.every((bytes) => bytes.byteLength <= 65_536))
  assert.deepEqual(batches.flatMap((bytes) => parseRegistryListBatch(decodeRegistryMessage(bytes))), addresses)
  assert.deepEqual([...encodeRegistryListBatches([])], [])
})

test('a registration at the frame boundary can still be withdrawn', () => {
  const address = { host: '127.0.0.1', port: 7001 }
  const limit = 65_535 - registryMethods.unregister.length
  const overhead = encodeRegistryMessage({ ...address, services: [''] }).byteLength
  const service = 's'.repeat(limit - overhead)
  const registration = { ...address, services: [service] }
  assert.equal(encodeRegistryRegistration(registration).byteLength, limit)
  assert.deepEqual(parseRegistration(registration), registration)
  const oversized = { ...address, services: [service + 's'] }
  assert.throws(() => parseRegistration(oversized), /bytes/)
  assert.throws(() => encodeRegistryRegistration(oversized), /bytes/)
})
