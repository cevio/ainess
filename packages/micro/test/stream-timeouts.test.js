import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createMicroClient } from '@ainess/micro'
import { RpcError, RpcMode, RpcServer } from '@ainess/rpc'
import { deferred } from '../../rpc/dist/deferred.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {readonly import('@ainess/rpc').RpcMethod[]} methods
 */
async function listen(t, methods) {
  let connections = 0
  const server = await RpcServer.listen({
    host: '127.0.0.1',
    port: 0,
    onPeer() { connections++ },
    methods,
  })
  t.after(() => server.close())
  return { address: server.address, get connections() { return connections } }
}

/** @type {import('@ainess/rpc').RpcMethod} */
const echoMethod = { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data }

test('a first response timeout cancels just that RPC on a shared TCP connection', { timeout: 5_000 }, async t => {
  const aborted = deferred()
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      if (!signal.aborted) await once(signal, 'abort')
      aborted.resolve(undefined)
    },
  }, echoMethod])
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())
  const echo = Buffer.from('same connection')
  assert.deepEqual(await client.request('orders', 'echo', echo), echo)

  const stream = client.stream('orders', 'events', undefined, {
    timeoutMs: 400,
    firstResponseTimeoutMs: 120,
  })
  await assert.rejects(stream.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase: 'first-response' } })
  await aborted.promise

  assert.deepEqual(await client.request('orders', 'echo', echo), echo)
  assert.equal(server.connections, 1)
})

test('first response timeout starts on first read and preserves shared discovery', { timeout: 5_000 }, async t => {
  const server = await listen(t, [echoMethod])
  const started = deferred()
  const release = deferred()
  let picks = 0
  /** @type {AbortSignal | undefined} */
  let discoverySignal
  const client = createMicroClient({
    discovery: {
      async pick(_query, options) {
        picks++
        discoverySignal = options?.signal
        started.resolve(undefined)
        await release.promise
        return server.address
      },
    },
  })
  t.after(async () => {
    release.resolve(undefined)
    await client.close()
  })
  const stream = client.stream('orders', 'never-dispatched', undefined, {
    timeoutMs: false,
    firstResponseTimeoutMs: 100,
  })
  await delay(150)
  assert.equal(picks, 0)

  const timedOut = assert.rejects(stream.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase: 'first-response' } })
  await started.promise
  const echo = Buffer.from('still waiting')
  const waiting = client.request('orders', 'echo', echo)
  void waiting.catch(() => {})
  await timedOut
  assert.equal(discoverySignal?.aborted, false)

  release.resolve(undefined)
  assert.deepEqual(await waiting, echo)
  assert.equal(picks, 1)
  assert.equal(server.connections, 1)
})

test('does not start a stream when discovery has used its first response budget', async t => {
  let now = 1_000
  let executions = 0
  t.mock.method(performance, 'now', () => now)
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle() {
      executions++
      yield Buffer.from('late')
    },
  }, echoMethod])
  const client = createMicroClient({
    discovery: {
      async pick({ service }) {
        if (service === 'orders') now += 300
        return server.address
      },
    },
  })
  t.after(() => client.close())
  await client.request('warm', 'echo')

  const stream = client.stream('orders', 'events', undefined, {
    timeoutMs: false, firstResponseTimeoutMs: 250,
  })
  await assert.rejects(stream.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase: 'first-response' } })
  assert.equal(executions, 0)
  assert.equal(server.connections, 1)
})

test('checks the first response deadline when TCP frames are received', { timeout: 5_000 }, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle({ data }) {
      const value = Buffer.from(data).toString()
      if (value.startsWith('late')) now += 300
      if (value !== 'late empty') yield data
    },
  }, echoMethod])
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())
  await client.request('orders', 'echo')

  const timely = Buffer.from('timely')
  const options = { timeoutMs: /** @type {const} */ (false), firstResponseTimeoutMs: 250 }
  const accepted = client.stream('orders', 'events', timely, {
    ...options,
    onResponse() { now += 300 },
  })
  assert.deepEqual(await accepted.next(), { done: false, value: timely })
  await accepted.return?.()

  for (const value of ['late data', 'late empty']) {
    const expired = client.stream('orders', 'events', Buffer.from(value), options)
    await assert.rejects(expired.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase: 'first-response' } })
  }
  assert.deepEqual(await client.request('orders', 'echo', timely), timely)
  assert.equal(server.connections, 1)
})

for (const phase of /** @type {const} */ (['total', 'read-idle'])) {
  test(`checks the ${phase} deadline on a later TCP response frame`, { timeout: 5_000 }, async t => {
    let now = 1_000
    t.mock.method(performance, 'now', () => now)
    const release = deferred()
    const server = await listen(t, [{
      name: 'events',
      mode: RpcMode.ServerStream,
      async *handle() {
        yield Buffer.from('first')
        await release.promise
        now += 300
        yield Buffer.from('late')
      },
    }, echoMethod])
    const client = createMicroClient({ discovery: { async pick() { return server.address } } })
    t.after(() => client.close())
    t.after(() => release.resolve(undefined))

    const stream = client.stream('orders', 'events', undefined, phase === 'total'
      ? { timeoutMs: 250 } : { timeoutMs: false, readIdleTimeoutMs: 250 })
    assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('first') })
    const rejected = assert.rejects(stream.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase } })
    release.resolve(undefined)
    await rejected
    assert.deepEqual(await client.request('orders', 'echo', Buffer.from('next')), Buffer.from('next'))
    assert.equal(server.connections, 1)
  })
}

test('checks the unary deadline before accepting a successful TCP response', { timeout: 5_000 }, async t => {
  let now = 1_000
  t.mock.method(performance, 'now', () => now)
  const server = await listen(t, [{
    name: 'work',
    mode: RpcMode.Unary,
    handle({ data }) {
      now += 300
      if (Buffer.from(data).toString() === 'error') throw new RpcError('INVALID_ARGUMENT', 'remote rejection')
      return data
    },
  }, echoMethod])
  const client = createMicroClient({ discovery: { async pick() { return server.address } } })
  t.after(() => client.close())
  await client.request('orders', 'echo')

  const onResponse = t.mock.fn()
  await assert.rejects(client.request('orders', 'work', undefined, { timeoutMs: 250, onResponse }), {
    code: 'DEADLINE_EXCEEDED',
  })
  assert.equal(onResponse.mock.callCount(), 0)
  await assert.rejects(client.request('orders', 'work', Buffer.from('error'), { timeoutMs: 250 }), {
    code: 'INVALID_ARGUMENT',
    message: 'remote rejection',
  })
  assert.equal(server.connections, 1)
})

test('read idle ignores consumer pauses and cancels a stalled read', { timeout: 5_000 }, async t => {
  const resume = deferred()
  const aborted = deferred()
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      yield Buffer.from('first')
      await resume.promise
      yield Buffer.from('second')
      if (!signal.aborted) await once(signal, 'abort')
      aborted.resolve(undefined)
    },
  }, echoMethod])
  const client = createMicroClient({
    timeoutMs: 150,
    resolveTimeoutMs: 1_000,
    discovery: { async pick() { return server.address } },
  })
  t.after(async () => {
    resume.resolve(undefined)
    await client.close()
  })
  const stream = client.stream('orders', 'events', undefined, {
    timeoutMs: false,
    readIdleTimeoutMs: 100,
  })
  assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('first') })
  await delay(220)
  resume.resolve(undefined)
  assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('second') })
  await assert.rejects(stream.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase: 'read-idle' } })
  await aborted.promise

  const echo = Buffer.from('still connected')
  assert.deepEqual(await client.request('orders', 'echo', echo, { timeoutMs: 1_000 }), echo)
  assert.equal(server.connections, 1)
})

test('upload activity does not extend the read idle timeout for a duplex stream', { timeout: 5_000 }, async t => {
  const uploadStopped = deferred()
  let waiting = false
  let chunksWhileWaiting = 0
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.Bidi,
    async *handle({ input }) {
      yield Buffer.from('first')
      for await (const chunk of input) {
        if (waiting && chunk.length) chunksWhileWaiting++
      }
    },
  }])
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())
  const stream = client.stream('orders', 'events', undefined, {
    timeoutMs: false,
    readIdleTimeoutMs: 160,
    async *input(signal) {
      try {
        while (!signal.aborted) {
          yield Buffer.from('upload')
          await delay(20, undefined, { signal })
        }
      } finally {
        uploadStopped.resolve(undefined)
      }
    },
  })
  assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('first') })
  waiting = true
  await assert.rejects(stream.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase: 'read-idle' } })
  await uploadStopped.promise
  assert.ok(chunksWhileWaiting > 0)
})

test('the client default total timeout still applies after the first response', { timeout: 5_000 }, async t => {
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      yield Buffer.from('first')
      if (!signal.aborted) await once(signal, 'abort')
    },
  }])
  const client = createMicroClient({
    timeoutMs: 250,
    resolveTimeoutMs: 1_000,
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())
  const stream = client.stream('orders', 'events', undefined, {
    firstResponseTimeoutMs: 1_000,
    readIdleTimeoutMs: 1_000,
  })
  assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('first') })
  await assert.rejects(stream.next(), { code: 'DEADLINE_EXCEEDED', cause: { phase: 'total' } })
})

test('caller abort still reports cancellation when the reason is a deadline error', { timeout: 5_000 }, async t => {
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      yield Buffer.from('first')
      if (!signal.aborted) await once(signal, 'abort')
    },
  }])
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())
  const caller = new AbortController()
  const stream = client.stream('orders', 'events', undefined, {
    signal: caller.signal,
    timeoutMs: false,
    readIdleTimeoutMs: 1_000,
  })
  assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('first') })
  const reason = new RpcError('DEADLINE_EXCEEDED', 'upstream deadline', { cause: { phase: 'read-idle' } })
  const waiting = assert.rejects(stream.next(), error =>
    error instanceof RpcError && error.code === 'CANCELLED' && error.cause === reason)
  caller.abort(reason)
  await waiting
})

test('cancellation in a paused stream failure observer preserves the settled remote error', {
  timeout: 5_000,
}, async t => {
  const release = deferred()
  t.after(() => release.resolve(undefined))
  const server = await listen(t, [{
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle() {
      yield Buffer.from('first')
      await release.promise
      yield Buffer.from('buffered')
      throw new RpcError('INVALID_ARGUMENT', 'stream rejected')
    },
  }, echoMethod])
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
    circuitBreaker: false,
  })
  t.after(() => client.close())
  const caller = new AbortController()
  const failed = deferred()
  const stream = client.stream('orders', 'events', undefined, {
    signal: caller.signal,
    timeoutMs: false,
    onFailure({ error }) {
      caller.abort(new Error('cancel after failure'))
      failed.resolve(error)
    },
  })
  assert.deepEqual(await stream.next(), { done: false, value: Buffer.from('first') })
  release.resolve(undefined)
  const failure = await failed.promise
  await assert.rejects(stream.next(), error => error === failure)
  const echo = Buffer.from('same connection')
  assert.deepEqual(await client.request('orders', 'echo', echo), echo)
  assert.equal(server.connections, 1)
})

test('a unary failure observer can use the settled error as the cancellation reason', { timeout: 5_000 }, async t => {
  const server = await listen(t, [{
    name: 'reject',
    mode: RpcMode.Unary,
    handle() { throw new RpcError('INVALID_ARGUMENT', 'request rejected') },
  }])
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())
  const caller = new AbortController()
  await assert.rejects(client.request('orders', 'reject', undefined, {
    signal: caller.signal,
    onFailure({ error }) { caller.abort(error) },
  }), error => error instanceof RpcError && error.code === 'INVALID_ARGUMENT' && error === caller.signal.reason)
})

for (const mode of [RpcMode.Unary, RpcMode.ServerStream]) {
  test(`a timing observer can abort with the settled RPC error for ${RpcMode[mode]}`, { timeout: 5_000 }, async t => {
    const server = await listen(t, [{
      name: 'reject',
      mode,
      handle() { throw new RpcError('INVALID_ARGUMENT', 'request rejected') },
    }, echoMethod])
    let caller = new AbortController()
    const client = createMicroClient({
      discovery: { async pick() { return server.address } },
      onTiming(event) {
        if (event.phase === 'rpc' && event.outcome === 'failure') caller.abort(event.error)
      },
    })
    t.after(() => client.close())

    // An empty method is rejected before the transport creates an in-flight call.
    for (const method of ['reject', '']) {
      caller = new AbortController()
      const options = { signal: caller.signal }
      const result = mode === RpcMode.Unary
        ? client.request('orders', method, undefined, options)
        : client.stream('orders', method, undefined, options).next()
      await assert.rejects(result, error =>
        error instanceof RpcError && error.code === 'INVALID_ARGUMENT' && error === caller.signal.reason)
    }
    const echo = Buffer.from('same connection')
    assert.deepEqual(await client.request('orders', 'echo', echo), echo)
    assert.equal(server.connections, 1)
  })
}

test('an empty stream clears the first response timer on normal completion', { timeout: 5_000 }, async t => {
  const server = await listen(t, [{ name: 'empty', mode: RpcMode.ServerStream, async *handle() {} }])
  const client = createMicroClient({
    discovery: { async pick() { return server.address } },
  })
  t.after(() => client.close())
  const timeoutMs = 60_023
  const arm = t.mock.method(globalThis, 'setTimeout')
  const disarm = t.mock.method(globalThis, 'clearTimeout')
  const phaseTimers = () => arm.mock.calls.filter(call => call.arguments[1] === timeoutMs).map(call => call.result)
  t.after(() => {
    for (const timer of phaseTimers()) clearTimeout(timer)
  })

  const stream = client.stream('orders', 'empty', undefined, { timeoutMs: false, firstResponseTimeoutMs: timeoutMs })
  assert.deepEqual(await stream.next(), { done: true, value: undefined })
  const armed = phaseTimers()
  const cleared = new Set(disarm.mock.calls.map(call => call.arguments[0]))
  assert.equal(armed.length, 1)
  assert.ok(cleared.has(armed[0]))
})
