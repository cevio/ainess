import assert from 'node:assert/strict'
import dns from 'node:dns'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { RpcPeer } from '@ainess/rpc'
import { RegistryServer, registryServer } from '@ainess/registry-server'

const listenAddress = { host: '127.0.0.1', port: 0 }
const orders = 'com.example.orders'
const billing = 'com.example.billing'
const reports = 'com.example.reports'
const methods = {
  register: 'registry.discovery.register',
  unregister: 'registry.discovery.unregister',
  list: 'registry.discovery.list',
  pick: 'registry.discovery.pick',
}

/** @typedef {import('@ainess/rpc').RpcAddress} RpcAddress */
/** @typedef {import('node:test').TestContext} TestContext */

/** @param {unknown} value */
const encode = value => Buffer.from(JSON.stringify(value))

/** @param {Uint8Array} value */
const decode = value => JSON.parse(Buffer.from(value).toString('utf8'))

/** @param {TestContext} t */
async function start(t) {
  const server = await RegistryServer.listen(listenAddress)
  t.after(() => server.close())
  return {
    async connect() {
      const peer = await RpcPeer.connect(server.address, { signal: AbortSignal.timeout(2_000) })
      t.after(() => peer.close())
      return peer
    },
  }
}

/** @param {RpcPeer} peer @param {string} method @param {unknown} request */
async function call(peer, method, request) {
  return decode(await peer.request(method, encode(request), { timeoutMs: 3_000 }))
}

/** @param {RpcPeer} peer @param {string} service */
async function list(peer, service) {
  /** @type {RpcAddress[]} */
  const addresses = []
  for await (const frame of peer.stream(methods.list, encode({ service }), { timeoutMs: 3_000 })) {
    for (const address of decode(frame)) addresses.push(address)
  }
  return addresses
}

/** @param {() => Promise<boolean>} predicate */
async function eventually(predicate) {
  const signal = AbortSignal.timeout(3_000)
  while (!(await predicate())) await delay(5, undefined, { signal })
}

test('disposing the Registry plugin cancels a pending hostname bind without leaving a listener', {
  timeout: 5_000,
}, async (t) => {
  const initial = await RegistryServer.listen(listenAddress)
  const address = initial.address
  await initial.close()

  const hostname = 'registry-bind.test'
  const lookup = dns.lookup
  /** @type {(complete: () => void) => void} */
  let reportLookup = () => {}
  /** @type {Promise<() => void>} */
  const lookupStarted = new Promise(resolve => { reportLookup = resolve })
  t.mock.method(dns, 'lookup', /** @type {typeof dns.lookup} */ ((host, options, callback) => {
    if (host !== hostname) return Reflect.apply(lookup, dns, [host, options, callback])
    const result = typeof options === 'object' && options.all
      ? [null, [{ address: address.host, family: 4 }]]
      : [null, address.host, 4]
    reportLookup(() => Reflect.apply(callback, undefined, result))
  }))

  const ctx = new Context()
  ctx.plugin(registryServer, { host: hostname, port: address.port })
  const completeLookup = await lookupStarted
  const disposed = ctx.fiber.dispose()
  const deadline = new AbortController()
  try {
    const stopped = await Promise.race([disposed.then(() => true), delay(500, false, { signal: deadline.signal })])
    assert.equal(stopped, true, 'Registry shutdown is still waiting for DNS')
  } finally {
    deadline.abort()
    completeLookup()
    await disposed
  }

  assert.equal(ctx.get('registryServer'), undefined)
  const rebound = await RegistryServer.listen(address)
  t.after(() => rebound.close())
  assert.deepEqual(rebound.address, address)
})

test('registration merges service IDs and unregister removes only the requesting peer’s claims', {
  timeout: 10_000,
}, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const other = await connect()
  const address = { host: 'orders.example', port: 7000 }
  const register = { ...address, services: [orders, billing, orders] }

  assert.deepEqual(await call(peer, methods.register, register), { registered: [orders, billing] })
  assert.deepEqual(await call(peer, methods.register, register), { registered: [orders, billing] })
  assert.deepEqual(await call(peer, methods.register, { ...address, services: [reports] }), { registered: [reports] })
  assert.deepEqual(await call(other, methods.unregister, { ...address, services: [billing] }), { removed: [] })
  assert.deepEqual(await list(other, billing), [address])

  await call(other, methods.register, { ...address, services: [orders] })
  assert.deepEqual(await list(other, orders), [address])
  const remove = { ...address, services: [orders, billing, billing] }
  assert.deepEqual(await call(peer, methods.unregister, remove), { removed: [orders, billing] })
  assert.deepEqual(await call(peer, methods.unregister, remove), { removed: [] })
  assert.deepEqual(await list(other, orders), [address])
  assert.deepEqual(await list(other, billing), [])
  assert.deepEqual(await list(other, reports), [address])
})

test('closing a peer removes its registrations across addresses and keeps shared registrations', {
  timeout: 10_000,
}, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const other = await connect()
  const query = await connect()
  const first = { host: 'orders.example', port: 7000 }
  const second = { host: 'orders.example', port: 7001 }

  await call(peer, methods.register, { ...first, services: [orders, billing] })
  await call(peer, methods.register, { ...second, services: [billing] })
  await call(other, methods.register, { ...first, services: [orders] })
  assert.deepEqual(await list(query, billing), [first, second])
  await peer.close()
  await eventually(async () => (await list(query, billing)).length === 0)
  assert.deepEqual(await list(query, orders), [first])
  await other.close()
  await eventually(async () => (await list(query, orders)).length === 0)
  assert.equal(await call(query, methods.pick, { service: orders }), null)
})

test('pick round-robins unique addresses independently per service and skips removed addresses', {
  timeout: 10_000,
}, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const other = await connect()
  const first = { host: 'orders-a.example', port: 7000 }
  const second = { host: 'orders-b.example', port: 7000 }
  const third = { host: 'orders-c.example', port: 7000 }
  for (const address of [first, second, third]) {
    await call(peer, methods.register, { ...address, services: [orders, billing] })
  }
  await call(other, methods.register, { ...second, services: [orders] })

  assert.deepEqual(await call(peer, methods.pick, { service: orders }), first)
  assert.deepEqual(await call(other, methods.pick, { service: orders }), second)
  assert.deepEqual(await call(peer, methods.pick, { service: billing }), first)
  assert.deepEqual(await call(other, methods.pick, { service: orders }), third)
  assert.deepEqual(await call(peer, methods.pick, { service: orders }), first)

  await call(peer, methods.unregister, { ...second, services: [orders] })
  assert.deepEqual(await call(peer, methods.pick, { service: orders }), second)
  await call(other, methods.unregister, { ...second, services: [orders] })
  assert.deepEqual(await call(peer, methods.pick, { service: orders }), third)
  assert.deepEqual(await call(peer, methods.pick, { service: orders }), first)
  assert.deepEqual(await call(peer, methods.pick, { service: billing }), second)
})

test('pick preserves insertion order through head, tail and final address removal', { timeout: 10_000 }, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const [first, second, third, fourth] = ['a', 'b', 'c', 'd'].map(host => ({ host, port: 7000 }))
  /** @param {RpcAddress} address */
  const register = address => call(peer, methods.register, { ...address, services: [orders] })
  /** @param {RpcAddress} address */
  const unregister = address => call(peer, methods.unregister, { ...address, services: [orders] })
  const pick = () => call(peer, methods.pick, { service: orders })

  for (const address of [first, second, third]) await register(address)
  assert.deepEqual(await pick(), first)
  await unregister(first)
  assert.deepEqual(await list(peer, orders), [second, third])
  assert.deepEqual(await pick(), second)
  await unregister(third)
  assert.deepEqual(await pick(), second)

  await register(fourth)
  await register(fourth)
  assert.deepEqual(await list(peer, orders), [second, fourth])
  assert.deepEqual(await pick(), second)
  assert.deepEqual(await pick(), fourth)
  await unregister(second)
  assert.deepEqual(await pick(), fourth)
  await unregister(fourth)
  assert.equal(await pick(), null)
  assert.deepEqual(await list(peer, orders), [])

  for (const address of [third, first]) await register(address)
  assert.deepEqual(await list(peer, orders), [third, first])
  assert.deepEqual(await pick(), third)
  assert.deepEqual(await pick(), first)
})

test('pick skips excluded addresses for one request and advances past the selected candidate', {
  timeout: 10_000,
}, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const other = await connect()
  const first = { host: 'a.example', port: 7000 }
  const second = { host: 'a.example', port: 7001 }
  const third = { host: 'b.example', port: 7000 }
  const addresses = [first, second, third]
  for (const address of addresses) await call(peer, methods.register, { ...address, services: [orders] })

  const filtered = { service: orders, exclude: [first, first, { host: third.host, port: second.port }] }
  assert.deepEqual(await call(peer, methods.pick, filtered), second)
  assert.deepEqual(await call(peer, methods.pick, filtered), third)
  assert.deepEqual(await call(peer, methods.pick, filtered), second)
  assert.equal(await call(peer, methods.pick, { service: orders, exclude: addresses }), null)
  assert.deepEqual(await list(peer, orders), addresses)
  assert.deepEqual(await call(other, methods.pick, { service: orders, exclude: [] }), third)
  assert.deepEqual(await call(other, methods.pick, { service: orders }), first)
})

test('list returns a finite snapshot across RPC frames while registrations change', { timeout: 15_000 }, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const expected = Array.from({ length: 400 }, (_, index) => ({
    host: `${index}${'a'.repeat(50)}.${'b'.repeat(60)}.${'c'.repeat(60)}.registry.example`,
    port: 7000,
  }))
  assert.ok(encode(expected).length > 64 * 1024)
  for (const address of expected) await call(peer, methods.register, { ...address, services: [orders] })

  const stream = peer.stream(methods.list, encode({ service: orders }), { timeoutMs: 3_000 })
  const first = await stream.next()
  assert.ok(!first.done)
  const received = decode(first.value)
  assert.ok(received.length > 0 && received.length < expected.length)
  await call(peer, methods.unregister, { ...expected.at(-1), services: [orders] })
  for await (const frame of stream) {
    for (const address of decode(frame)) received.push(address)
  }
  assert.deepEqual(received, expected)
  assert.deepEqual(await list(peer, orders), expected.slice(0, -1))
})

test('invalid discovery requests are rejected without applying a partial registration', {
  timeout: 10_000,
}, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const address = { host: 'orders.example', port: 7000 }
  await assert.rejects(call(peer, methods.register, { ...address, services: [orders, 42] }), {
    code: 'INVALID_ARGUMENT',
  })
  await assert.rejects(call(peer, methods.pick, { service: false }), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(call(peer, methods.pick, { service: orders, exclude: [{ ...address, port: 0 }] }), {
    code: 'INVALID_ARGUMENT',
  })
  await assert.rejects(peer.stream(methods.list, Buffer.from('{')).next(), { code: 'INVALID_ARGUMENT' })
  assert.deepEqual(await list(peer, orders), [])
})

test('the largest registration request can also be withdrawn over TCP', { timeout: 10_000 }, async (t) => {
  const { connect } = await start(t)
  const peer = await connect()
  const address = { host: 'orders.example', port: 7000 }
  const limit = 65535 - Buffer.byteLength(methods.unregister)
  const service = 's'.repeat(limit - encode({ ...address, services: [''] }).byteLength)
  const request = { ...address, services: [service] }
  assert.equal(encode(request).byteLength, limit)

  assert.deepEqual(await call(peer, methods.register, request), { registered: [service] })
  assert.deepEqual(await list(peer, service), [address])
  assert.deepEqual(await call(peer, methods.unregister, request), { removed: [service] })
  assert.deepEqual(await list(peer, service), [])
  await assert.rejects(call(peer, methods.register, { ...address, services: [service + 's'] }), {
    code: 'INVALID_ARGUMENT',
  })
})

test('Cordis injects the bound registry and closes its listener and peers on disposal', {
  timeout: 10_000,
}, async (t) => {
  const root = new Context()
  t.after(() => root.fiber.dispose())
  const fiber = root.plugin(registryServer, listenAddress)
  await fiber.await()
  const server = root.get('registryServer')
  assert.ok(server instanceof RegistryServer)
  const address = server.address
  const peer = await RpcPeer.connect(address, { signal: AbortSignal.timeout(2_000) })
  t.after(() => peer.close())
  const closed = new Promise(resolve => peer.onClose(resolve))

  await fiber.dispose()
  await closed
  assert.equal(root.get('registryServer', false), undefined)
  await assert.rejects(RpcPeer.connect(address, { signal: AbortSignal.timeout(2_000) }))
})
