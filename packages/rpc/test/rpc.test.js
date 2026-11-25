import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { RpcClient, RpcError, RpcMode, RpcServer } from '@ainess/rpc'
import { encodeHeader, encodeHello, FrameType } from '../dist/wire.js'

/** @param {string} value */
const bytes = value => Buffer.from(value)

/** @param {Uint8Array} value */
const decode = value => Buffer.from(value).toString()

/** @param {AsyncIterable<Uint8Array>} source */
async function collect(source) {
  const chunks = []
  for await (const chunk of source) chunks.push(decode(chunk))
  return chunks
}

function latch() {
  let release = () => {}
  const promise = new Promise(resolve => { release = () => resolve(undefined) })
  return { promise, resolve: release }
}

/** @param {AbortSignal} signal */
function untilAborted(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true }))
}

/**
 * @param {import('node:test').TestContext} t
 * @param {import('@ainess/rpc').RpcMethod[]} [methods]
 */
async function startPair(t, methods) {
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0, ...(methods && { methods }) })
  t.after(() => server.close())
  const client = await RpcClient.connect(server.address, { signal: AbortSignal.timeout(2_000) })
  t.after(() => client.close())
  return { client, server }
}

test('methods registered after connect are visible on an existing TCP connection', { timeout: 5_000 }, async t => {
  const { client, server } = await startPair(t)
  await assert.rejects(client.request('ping'), { code: 'NOT_FOUND' })
  const unregister = server.register({ name: 'ping', mode: RpcMode.Unary, handle: () => bytes('pong') })
  assert.equal(decode(await client.request('ping')), 'pong')

  assert.throws(() => server.register({ name: 'ping', mode: RpcMode.Unary, handle: () => bytes('other') }), {
    code: 'INVALID_ARGUMENT',
  })
  await unregister()
  await assert.rejects(client.request('ping'), { code: 'NOT_FOUND' })

  await server.close()
  assert.throws(() => server.register({ name: 'ping', mode: RpcMode.Unary, handle: () => bytes('pong') }), {
    code: 'UNAVAILABLE',
  })
})

test('unregister drains accepted calls and permits a replacement under the same name', { timeout: 5_000 }, async t => {
  const entered = latch()
  const release = latch()
  t.after(() => release.resolve())
  const { client, server } = await startPair(t)
  const unregister = server.register({
    name: 'lookup',
    mode: RpcMode.Unary,
    async handle() {
      entered.resolve()
      await release.promise
      return bytes('old handler')
    },
  })

  const accepted = client.request('lookup')
  void accepted.catch(() => {})
  await entered.promise
  let drained = 0
  const first = unregister().then(() => { drained++ })
  const second = unregister().then(() => { drained++ })
  await assert.rejects(client.request('lookup'), { code: 'NOT_FOUND' })
  assert.equal(drained, 0)

  const removeReplacement = server.register({ name: 'lookup', mode: RpcMode.Unary, handle: () => bytes('replacement') })
  assert.equal(decode(await client.request('lookup')), 'replacement')
  release.resolve()
  assert.equal(decode(await accepted), 'old handler')
  await Promise.all([first, second, unregister()])
  assert.equal(drained, 2)
  assert.equal(decode(await client.request('lookup')), 'replacement')
  await removeReplacement()
  await assert.rejects(client.request('lookup'), { code: 'NOT_FOUND' })
})

test('unregister waits for finally when a streamed response is cancelled', { timeout: 5_000 }, async t => {
  const cleanupStarted = latch()
  const finishCleanup = latch()
  t.after(() => finishCleanup.resolve())
  const { client, server } = await startPair(t)
  const unregister = server.register({
    name: 'events',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      try {
        yield bytes('started')
        await untilAborted(signal)
      } finally {
        cleanupStarted.resolve()
        await finishCleanup.promise
      }
    },
  })

  const stream = client.stream('events')
  assert.deepEqual(await stream.next().then(result => [result.done, decode(result.value)]), [false, 'started'])
  let drained = false
  const removing = unregister().then(() => { drained = true })
  await stream.return?.()
  await cleanupStarted.promise
  await assert.rejects(client.stream('events').next(), { code: 'NOT_FOUND' })
  assert.equal(drained, false)
  finishCleanup.resolve()
  await removing
})

test('unregister drains a response iterator returned after cancellation', { timeout: 5_000 }, async t => {
  const entered = latch()
  const cleanupStarted = latch()
  const finishCleanup = latch()
  t.after(() => finishCleanup.resolve())
  const { client, server } = await startPair(t)
  const unregister = server.register({
    name: 'late.response',
    mode: RpcMode.ServerStream,
    async handle({ signal }) {
      entered.resolve()
      await untilAborted(signal)
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => assert.fail('a cancelled response must not be read'),
            async return() {
              cleanupStarted.resolve()
              await finishCleanup.promise
              return { done: /** @type {const} */ (true), value: undefined }
            },
          }
        },
      }
    },
  })

  const stream = client.stream('late.response')
  const read = stream.next()
  void read.catch(() => {})
  await entered.promise
  const removing = unregister()
  await stream.return?.()
  await read
  assert.equal(await Promise.race([
    cleanupStarted.promise.then(() => 'cleanup'),
    removing.then(() => 'removed'),
  ]), 'cleanup')
  finishCleanup.resolve()
  await removing
})

test('stream cancellation reaches the response iterator after a handler abort listener', { timeout: 5_000 }, async t => {
  const aborted = latch()
  const pendingRead = latch()
  t.after(() => pendingRead.resolve())
  const { client, server } = await startPair(t)
  let returned = false
  const unregister = server.register({
    name: 'events.cancel',
    mode: RpcMode.ServerStream,
    handle({ signal }) {
      signal.addEventListener('abort', event => {
        event.stopImmediatePropagation()
        aborted.resolve()
      }, { once: true })
      return {
        [Symbol.asyncIterator]() {
          let started = false
          return {
            async next() {
              if (started) await pendingRead.promise
              started = true
              return { done: /** @type {const} */ (false), value: bytes('event') }
            },
            async return() {
              returned = true
              pendingRead.resolve()
              return { done: /** @type {const} */ (true), value: undefined }
            },
          }
        },
      }
    },
  })

  const stream = client.stream('events.cancel')
  assert.equal(decode((await stream.next()).value), 'event')
  const draining = unregister()
  await stream.return?.()
  await aborted.promise
  await delay(0)
  assert.equal(returned, true)
  await draining
})

test('omitted request data reaches every RPC mode as empty bytes', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t, [
    { name: 'empty.echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'empty.list', mode: RpcMode.ServerStream, async *handle({ data }) { yield data } },
    {
      name: 'empty.upload',
      mode: RpcMode.ClientStream,
      async handle({ data, input }) {
        return bytes([decode(data), ...await collect(input)].join('|'))
      },
    },
    {
      name: 'empty.chat',
      mode: RpcMode.Bidi,
      async *handle({ data, input }) {
        yield data
        yield* input
      },
    },
  ])
  async function* upload() {
    yield bytes('chunk')
  }
  assert.deepEqual(await Promise.all([
    client.request('empty.echo').then(decode),
    collect(client.stream('empty.list')),
    client.request('empty.upload', { input: upload }).then(decode),
    collect(client.stream('empty.chat', { input: upload })),
    client.request('empty.echo', undefined, { timeoutMs: 1_000 }).then(decode),
  ]), ['', [''], '|chunk', ['', 'chunk'], ''])
})

test('Uint8Arrays from another realm work as request data, responses and stream chunks', { timeout: 5_000 }, async t => {
  /** @type {Uint8Array} */
  const foreign = runInNewContext('Uint8Array.of(0, 114, 112, 99, 0).subarray(1, 4)')
  assert.equal(foreign instanceof Uint8Array, false)
  const { client } = await startPair(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'direct', mode: RpcMode.Unary, handle: () => foreign },
    { name: 'promised', mode: RpcMode.Unary, handle: async () => foreign },
    {
      name: 'bidi',
      mode: RpcMode.Bidi,
      async *handle({ input }) {
        yield foreign
        yield* input
      },
    },
  ])

  assert.deepEqual(await Promise.all([
    client.request('echo', foreign).then(decode),
    client.request('direct').then(decode),
    client.request('promised').then(decode),
    collect(client.stream('bidi', { async *input() { yield foreign } })),
  ]), ['rpc', 'rpc', 'rpc', ['rpc', 'rpc']])
})

test('a signal option is read once before assigning the call ID', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
  ])
  const controller = new AbortController()
  let reads = 0
  const result = await client.request('echo', bytes('outer'), {
    get signal() {
      if (++reads === 2) void client.request('echo', bytes('nested')).catch(() => {})
      return controller.signal
    },
  })

  assert.equal(decode(result), 'outer')
  assert.equal(reads, 1)
  assert.equal(decode(await client.request('echo', bytes('next'))), 'next')
})

test('payload bounds use the real typed-array view instead of shadowed properties', { timeout: 5_000 }, async t => {
  let reads = 0
  const backing = Uint8Array.of(0, 114, 112, 99, 0)
  const other = Uint8Array.of(100, 97, 116, 97)
  class ObservedBytes extends Uint8Array {
    get byteLength() {
      reads++
      return 1
    }

    get byteOffset() {
      reads++
      return 0
    }

    get buffer() {
      reads++
      return other.buffer
    }
  }
  const view = new ObservedBytes(backing.buffer, 1, 3)
  const buffer = bytes('buf')
  Object.defineProperty(buffer, 'length', {
    get() {
      reads++
      return 1
    },
  })
  const { client } = await startPair(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'buffer', mode: RpcMode.Unary, handle: () => buffer },
    { name: 'stream', mode: RpcMode.ServerStream, async *handle() { yield view } },
  ])

  assert.deepEqual(await Promise.all([
    client.request('echo', view).then(decode),
    client.request('echo', buffer).then(decode),
    client.request('buffer').then(decode),
    collect(client.stream('stream')),
  ]), ['rpc', 'buf', 'buf', ['rpc']])
  assert.equal(reads, 0)
})

test('byte views backed by ArrayBuffer subclasses preserve their actual bytes', { timeout: 5_000 }, async t => {
  let reads = 0
  class ObservedBuffer extends ArrayBuffer {
    get byteLength() {
      reads++
      return super.byteLength
    }
  }
  const backing = new ObservedBuffer(5)
  const view = new Uint8Array(backing, 1, 3)
  view.set(bytes('rpc'))
  const { client } = await startPair(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'view', mode: RpcMode.Unary, handle: () => view },
    { name: 'stream', mode: RpcMode.ServerStream, async *handle() { yield view } },
  ])

  assert.deepEqual(await Promise.all([
    client.request('echo', view).then(decode),
    client.request('view').then(decode),
    collect(client.stream('stream')),
  ]), ['rpc', 'rpc', ['rpc']])
  assert.equal(reads, 0)
})

test('bare backing stores are rejected instead of invoking the method with empty data', { timeout: 5_000 }, async t => {
  let calls = 0
  const { client } = await startPair(t, [{
    name: 'record',
    mode: RpcMode.Unary,
    handle({ data }) {
      calls++
      return data
    },
  }])

  for (const storage of [new ArrayBuffer(4), new SharedArrayBuffer(4)]) {
    // @ts-expect-error JavaScript callers can pass a backing store instead of a byte view.
    await assert.rejects(client.request('record', storage), { code: 'INVALID_ARGUMENT' })
  }
  assert.equal(decode(await client.request('record', bytes('active'))), 'active')
  assert.equal(calls, 1)
})

test('invalidated byte views fail their own call without disconnecting the peer', { timeout: 5_000 }, async t => {
  const request = new Uint8Array(4)
  const reply = Buffer.alloc(4)
  structuredClone(request.buffer, { transfer: [request.buffer] })
  assert.ok(reply.buffer instanceof ArrayBuffer)
  structuredClone(reply.buffer, { transfer: [reply.buffer] })
  /** @type {Uint8Array} */
  const outOfBounds = runInNewContext(`
    const buffer = new ArrayBuffer(4, { maxByteLength: 8 })
    const view = new Uint8Array(buffer, 2, 2)
    buffer.resize(1)
    view
  `)
  const { client } = await startPair(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'reply', mode: RpcMode.Unary, handle: () => reply },
    { name: 'stream', mode: RpcMode.ServerStream, async *handle() { yield reply } },
  ])

  await assert.rejects(client.request('echo', request), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(client.request('echo', outOfBounds), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(client.request('reply'), { code: 'INVALID_ARGUMENT' })
  await assert.rejects(client.stream('stream').next(), { code: 'INVALID_ARGUMENT' })
  assert.equal(decode(await client.request('echo', bytes('active'))), 'active')
})

test('transferring an empty received view keeps other empty payloads usable', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'stream', mode: RpcMode.ServerStream, async *handle() { yield new Uint8Array(0) } },
  ])

  const unary = await client.request('echo')
  assert.ok(unary.buffer instanceof ArrayBuffer)
  structuredClone(unary.buffer, { transfer: [unary.buffer] })

  const stream = client.stream('stream')
  const chunk = await stream.next()
  assert.equal(chunk.done, false)
  assert.ok(chunk.value.buffer instanceof ArrayBuffer)
  structuredClone(chunk.value.buffer, { transfer: [chunk.value.buffer] })
  assert.equal((await stream.next()).done, true)

  assert.equal((await client.request('echo')).byteLength, 0)
  assert.equal(decode(await client.request('echo', bytes('active'))), 'active')
})

test('exact frame limits succeed and a byte over the limit leaves the connection usable', { timeout: 5_000 }, async t => {
  const methodName = '界'.repeat(85)
  const maxFrame = 64 * 1024
  const maxRequest = maxFrame - 1 - Buffer.byteLength(methodName)
  const largest = Buffer.alloc(maxRequest, 0x61)
  const streamChunks = [0, 4_096, 4_097, maxFrame].map((size, index) => Buffer.alloc(size, index))
  const { client } = await startPair(t, [
    { name: methodName, mode: RpcMode.Unary, handle: ({ data }) => data },
    { name: 'largestReply', mode: RpcMode.Unary, handle: () => streamChunks[3] },
    { name: 'oversizedReply', mode: RpcMode.Unary, handle: () => Buffer.alloc(maxFrame + 1) },
    { name: 'streams', mode: RpcMode.ServerStream, async *handle() { yield* streamChunks } },
    { name: 'upload', mode: RpcMode.ClientStream, async handle({ input }) {
      let received = 0
      for await (const chunk of input) received += chunk.length
      return bytes(String(received))
    } },
  ])

  assert.deepEqual(await client.request(methodName, largest), largest)
  await assert.rejects(client.request(methodName, Buffer.alloc(maxRequest + 1)), { code: 'INVALID_ARGUMENT' })
  assert.deepEqual(await client.request('largestReply'), streamChunks[3])
  await assert.rejects(client.request('oversizedReply'), { code: 'INVALID_ARGUMENT' })
  assert.deepEqual(await collect(client.stream('streams')), streamChunks.map(decode))
  await assert.rejects(client.request('upload', {
    async *input() { yield Buffer.alloc(maxFrame + 1) },
  }), { code: 'INVALID_ARGUMENT' })
  assert.equal(await client.request('upload', {
    async *input() { yield* streamChunks },
  }).then(decode), String(streamChunks.reduce((size, chunk) => size + chunk.length, 0)))
})

test('deadlines accept the maximum timer value and reject invalid values before dispatch', { timeout: 5_000 }, async t => {
  let calls = 0
  const { client } = await startPair(t, [{
    name: 'echo',
    mode: RpcMode.Unary,
    handle() {
      calls++
      return bytes('ok')
    },
  }])
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x80000000]) {
    await assert.rejects(client.request('echo', { timeoutMs }), { code: 'INVALID_ARGUMENT' })
  }
  assert.equal(await client.request('echo', { timeoutMs: 0x7fffffff }).then(decode), 'ok')
  assert.equal(calls, 1)
})

test('aborting from another option accessor prevents dispatch', { timeout: 5_000 }, async t => {
  let calls = 0
  const { client } = await startPair(t, [
    {
      name: 'record',
      mode: RpcMode.Unary,
      handle() {
        calls++
        return bytes('called')
      },
    },
    { name: 'barrier', mode: RpcMode.Unary, handle: () => bytes('processed') },
  ])
  const controller = new AbortController()
  await assert.rejects(client.request('record', {
    signal: controller.signal,
    get timeoutMs() {
      controller.abort()
      return 1_000
    },
  }), { code: 'CANCELLED' })

  assert.equal(decode(await client.request('barrier')), 'processed')
  assert.equal(calls, 0)
})

test('UTF-8 method names dispatch exactly through the same TCP connection', { timeout: 5_000 }, async t => {
  const nameAtLimit = '界'.repeat(85)
  const { client } = await startPair(t, [
    { name: 'files.上传📦', mode: RpcMode.Unary, handle: () => bytes('upload') },
    { name: 'files.预览', mode: RpcMode.Unary, handle: () => bytes('preview') },
    { name: nameAtLimit, mode: RpcMode.Unary, handle: ({ data }) => data },
  ])

  const result = await Promise.all([
    client.request('files.上传📦', bytes('')).then(decode),
    client.request('files.预览', bytes('')).then(decode),
    client.request(nameAtLimit, bytes('at the byte limit')).then(decode),
  ])
  assert.deepEqual(result, ['upload', 'preview', 'at the byte limit'])
  const largestRequest = Buffer.alloc(64 * 1024 - 256, 7)
  assert.deepEqual(Buffer.from(await client.request(nameAtLimit, largestRequest)), largestRequest)
  await assert.rejects(client.request(nameAtLimit, Buffer.alloc(largestRequest.length + 1)), {
    code: 'INVALID_ARGUMENT',
  })
  await assert.rejects(client.request('files.删除', bytes('')), { code: 'NOT_FOUND' })
  assert.equal(decode(await client.request('files.预览', bytes(''))), 'preview')
})

test('invalid method names are rejected before sending or listening', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t, [{
    name: 'ping',
    mode: RpcMode.Unary,
    handle: () => bytes('pong'),
  }])

  for (const name of ['', '界'.repeat(86), 'files.\ud800']) {
    await assert.rejects(client.request(name, bytes('')), { code: 'INVALID_ARGUMENT' })
    await assert.rejects(RpcServer.listen({
      host: '127.0.0.1', port: 0,
      methods: [{ name, mode: RpcMode.Unary, handle: ({ data }) => data }],
    }).then(server => server.close()), { code: 'INVALID_ARGUMENT' })
  }
  assert.equal(decode(await client.request('ping', bytes(''))), 'pong')
})

test('registering two handlers with the same name fails', { timeout: 5_000 }, async () => {
  await assert.rejects(RpcServer.listen({
    host: '127.0.0.1', port: 0,
    methods: [
      { name: 'files.preview', mode: RpcMode.Unary, handle: ({ data }) => data },
      { name: 'files.preview', mode: RpcMode.ClientStream, handle: ({ data }) => data },
    ],
  }).then(server => server.close()), { code: 'INVALID_ARGUMENT' })
})

test('one TCP connection handles unary, server streaming, and a half-closed upload', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t, [
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
    {
      name: 'chunks',
      mode: RpcMode.ServerStream,
      async *handle({ data }) {
        yield data
        yield bytes('')
        yield bytes('last')
      },
    },
    {
      name: 'collect',
      mode: RpcMode.ClientStream,
      async handle({ data, input }) {
        return bytes([decode(data), ...await collect(input)].join('|'))
      },
    },
  ])

  const result = await Promise.all([
    client.request('echo', bytes('unary')).then(decode),
    collect(client.stream('chunks', bytes('first'))),
    client.request('collect', bytes('metadata'), {
      async *input() {
        yield bytes('one')
        yield bytes('')
        yield bytes('two')
      },
    }).then(decode),
  ])
  assert.deepEqual(result, ['unary', ['first', '', 'last'], 'metadata|one||two'])
})

test('bidi can respond before upload produces its first chunk', { timeout: 5_000 }, async t => {
  const allowUpload = latch()
  t.after(() => allowUpload.resolve())
  const { client } = await startPair(t, [{
    name: 'mirror',
    mode: RpcMode.Bidi,
    async *handle({ data, input }) {
      yield data
      for await (const chunk of input) yield chunk
      yield bytes('after input EOF')
    },
  }])

  const stream = client.stream('mirror', bytes('ready'), {
    async *input(signal) {
      await Promise.race([allowUpload.promise, untilAborted(signal)])
      if (!signal.aborted) yield bytes('upload')
    },
  })
  assert.deepEqual(await stream.next().then(result => [result.done, decode(result.value)]), [false, 'ready'])
  allowUpload.resolve()
  assert.deepEqual(await collect(stream), ['upload', 'after input EOF'])
})

for (const stop of ['stop()', 'break']) {
  test(`server ${stop} aborts a blocked upload and keeps responding`, { timeout: 5_000 }, async t => {
    const uploadWaiting = latch()
    const uploadStopped = latch()
    const { client } = await startPair(t, [{
      name: 'upload',
      mode: RpcMode.Bidi,
      async *handle({ input, signal }) {
        for await (const chunk of input) {
          assert.equal(decode(chunk), 'first upload')
          await uploadWaiting.promise
          if (stop === 'stop()') input.stop()
          else break
        }
        await uploadStopped.promise
        assert.equal(signal.aborted, false)
        yield bytes('response after stop')
      },
    }])

    const response = client.stream('upload', bytes(''), {
      async *input(signal) {
        yield bytes('first upload')
        uploadWaiting.resolve()
        await untilAborted(signal)
        uploadStopped.resolve()
      },
    })
    assert.deepEqual(await collect(response), ['response after stop'])
  })
}

test('breaking the client response aborts both the handler and the upload', { timeout: 5_000 }, async t => {
  const uploadStarted = latch()
  const uploadStopped = latch()
  const handlerStopped = latch()
  const { client } = await startPair(t, [{
    name: 'upload',
    mode: RpcMode.Bidi,
    async *handle({ signal }) {
      signal.addEventListener('abort', () => handlerStopped.resolve(), { once: true })
      await uploadStarted.promise
      yield bytes('first response')
      await untilAborted(signal)
    },
  }])

  const response = client.stream('upload', bytes(''), {
    async *input(signal) {
      uploadStarted.resolve()
      await untilAborted(signal)
      uploadStopped.resolve()
    },
  })
  for await (const chunk of response) {
    assert.equal(decode(chunk), 'first response')
    break
  }
  await Promise.all([uploadStopped.promise, handlerStopped.promise])
})

test('abort, deadline, and remote stream errors affect only their own calls', { timeout: 5_000 }, async t => {
  const handlerStarted = latch()
  const handlerStopped = latch()
  const { client } = await startPair(t, [
    {
      name: 'wait',
      mode: RpcMode.Unary,
      async handle({ signal }) {
        handlerStarted.resolve()
        await untilAborted(signal)
        handlerStopped.resolve()
        return bytes('')
      },
    },
    {
      name: 'failingStream',
      mode: RpcMode.ServerStream,
      async *handle() {
        yield bytes('before error')
        throw new RpcError('INVALID_ARGUMENT', 'bad input')
      },
    },
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
  ])

  const controller = new AbortController()
  const cancelled = assert.rejects(client.request('wait', bytes(''), { signal: controller.signal }), { code: 'CANCELLED' })
  await handlerStarted.promise
  controller.abort()
  await Promise.all([cancelled, handlerStopped.promise])

  await assert.rejects(client.request('wait', bytes(''), { timeoutMs: 30 }), { code: 'DEADLINE_EXCEEDED' })
  const response = client.stream('failingStream', bytes(''))
  assert.deepEqual(await response.next().then(result => [result.done, decode(result.value)]), [false, 'before error'])
  await assert.rejects(response.next(), { code: 'INVALID_ARGUMENT', message: 'bad input' })
  await assert.rejects(client.request('missing', bytes('')), { code: 'NOT_FOUND' })
  await assert.rejects(client.request('failingStream', bytes('')), { code: 'INVALID_ARGUMENT' })

  const invalid = client.stream('', bytes(''))
  await assert.rejects(invalid.next(), { code: 'INVALID_ARGUMENT' })
  const ended = await invalid.next().then(result => result.done, error => {
    assert.equal(error.code, 'INVALID_ARGUMENT')
    return true
  })
  assert.equal(ended, true)
  assert.equal(decode(await client.request('echo', bytes('still connected'))), 'still connected')
})

test('an unreadable upload error rejects the call and preserves the connection', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t, [
    {
      name: 'upload',
      mode: RpcMode.ClientStream,
      async handle({ input }) {
        for await (const chunk of input) void chunk
        return bytes('done')
      },
    },
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
  ])
  const failure = Proxy.revocable(new Error('unreadable upload failure'), {})
  failure.revoke()

  await assert.rejects(client.request('upload', {
    input: () => { throw failure.proxy },
    timeoutMs: 1_000,
  }), { code: 'INTERNAL', message: 'RPC input failed' })
  assert.equal(decode(await client.request('echo', bytes('ok'))), 'ok')
})

test('an unreadable stream startup error rejects the first read', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t)
  const failure = Proxy.revocable(new Error('unreadable option failure'), {})
  failure.revoke()

  const output = client.stream('output', {
    /** @returns {never} */
    get input() { throw failure.proxy },
  })
  await assert.rejects(output.next(), { code: 'INTERNAL', message: 'RPC startup failed' })
})

test('cancelling while reading an upload element leaves the connection open', { timeout: 5_000 }, async t => {
  const { client } = await startPair(t, [
    {
      name: 'upload',
      mode: RpcMode.ClientStream,
      async handle({ input }) {
        for await (const chunk of input) void chunk
        return bytes('done')
      },
    },
    { name: 'bounce', mode: RpcMode.Unary, handle: ({ peer, data }) => peer.request('echo', data) },
  ])
  client.register({ name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data })
  const controller = new AbortController()

  await assert.rejects(client.request('upload', {
    input: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return {
              done: /** @type {const} */ (false),
              get value() {
                controller.abort()
                return bytes('cancelled data')
              },
            }
          },
        }
      },
    }),
    signal: controller.signal,
    timeoutMs: 1_000,
  }), { code: 'CANCELLED' })
  assert.equal(decode(await client.request('bounce', bytes('ok'))), 'ok')
})

test('a slow stream reader leaves room for short RPCs on the same connection', { timeout: 5_000 }, async t => {
  let produced = 0
  const chunk = Buffer.alloc(64 * 1024)
  const { client } = await startPair(t, [
    {
      name: 'largeStream',
      mode: RpcMode.ServerStream,
      async *handle() {
        for (; produced < 256; produced++) yield chunk
      },
    },
    { name: 'echo', mode: RpcMode.Unary, handle: ({ data }) => data },
  ])

  const large = client.stream('largeStream', bytes(''))
  const first = await large.next()
  assert.equal(first.done, false)
  assert.equal(first.value.byteLength, chunk.byteLength)
  await delay(25)
  const messages = Array.from({ length: 24 }, (_, index) => String(index))
  const responses = await Promise.all(messages.map(message => client.request('echo', bytes(message)).then(decode)))
  assert.deepEqual(responses, messages)
  assert.ok(produced < 256, 'the stalled stream should still be backpressured')
  await large.return?.()
})

test('closing the listener terminates an in-flight call and permits repeated close', { timeout: 5_000 }, async t => {
  const started = latch()
  const stopped = latch()
  const { client, server } = await startPair(t, [{
    name: 'wait',
    mode: RpcMode.Unary,
    async handle({ signal }) {
      started.resolve()
      await untilAborted(signal)
      stopped.resolve()
      return bytes('')
    },
  }])

  const failed = assert.rejects(client.request('wait', bytes('')), { code: 'UNAVAILABLE' })
  await started.promise
  await Promise.all([server.close(), server.close(), failed, stopped.promise])
  await Promise.all([client.close(), client.close()])
  await assert.rejects(client.request('wait', bytes('')), { code: 'UNAVAILABLE' })
})

test('an oversized frame header closes only the malformed TCP connection', { timeout: 5_000 }, async t => {
  const { client, server } = await startPair(t, [{
    name: 'echo',
    mode: RpcMode.Unary,
    handle: ({ data }) => data,
  }])
  const malformed = createConnection(server.address)
  t.after(() => { malformed.destroy() })
  const closed = new Promise(resolve => malformed.once('close', resolve))
  malformed.on('error', () => {})
  malformed.resume()

  const header = Buffer.alloc(12)
  header.writeUInt32BE(0xffffffff)
  header.writeUInt8(1, 8) // HELLO
  malformed.write(header)
  await closed

  assert.equal(decode(await client.request('echo', bytes('healthy'))), 'healthy')
})

test('malformed OPEN names cannot alias a method named with U+FFFD', { timeout: 5_000 }, async t => {
  let calls = 0
  const replacement = '\ufffd'
  const { client, server } = await startPair(t, [{
    name: replacement,
    mode: RpcMode.Unary,
    handle({ data }) {
      calls++
      return data
    },
  }])
  assert.equal(decode(await client.request(replacement, bytes('valid name'))), 'valid name')
  const hello = { type: FrameType.Hello, id: 0, flags: 0, body: encodeHello() }
  for (const body of [Buffer.of(1, 0x80), Buffer.of(2, 0x78)]) {
    const malformed = createConnection(server.address)
    t.after(() => { malformed.destroy() })
    const closed = new Promise(resolve => malformed.once('close', resolve))
    malformed.on('error', () => {})
    malformed.resume()

    const open = { type: FrameType.Open, id: 1, flags: RpcMode.Unary, body }
    malformed.write(Buffer.concat([encodeHeader(hello), hello.body, encodeHeader(open), body]))
    await closed
  }
  assert.equal(calls, 1)
  assert.equal(decode(await client.request(replacement, bytes('healthy'))), 'healthy')
})

test('cancelling a handshake closes the TCP socket before a peer responds', { timeout: 5_000 }, async t => {
  /** @type {import('node:net').Socket | undefined} */
  let peer
  const accepted = latch()
  const listener = createServer(socket => {
    peer = socket
    socket.on('error', () => {})
    socket.resume()
    accepted.resolve()
  })
  t.after(() => {
    peer?.destroy()
    return new Promise(resolve => listener.close(() => resolve(undefined)))
  })
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')

  const controller = new AbortController()
  const connect = RpcClient.connect({ host: '127.0.0.1', port: address.port }, { signal: controller.signal })
  const cancelled = assert.rejects(connect, { code: 'CANCELLED' })
  await accepted.promise
  assert.ok(peer)
  const closed = once(peer, 'close')
  controller.abort()
  await Promise.all([cancelled, closed])
})
