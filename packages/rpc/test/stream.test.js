import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'
import { IncomingStream } from '../dist/stream.js'

/**
 * @param {import('node:test').TestContext} t
 * @param {import('@ainess/rpc').RpcMethod[]} methods
 */
async function connect(t, methods) {
  const server = await RpcServer.listen({ host: '127.0.0.1', port: 0, methods })
  t.after(() => server.close())
  const peer = await RpcPeer.connect(server.address)
  t.after(() => peer.close())
  return peer
}

test('queued tiny data does not hold on to its large socket read buffer', async () => {
  const incoming = new IncomingStream(() => {})
  const socketRead = Buffer.alloc(64 * 1024, 97)
  const tiny = socketRead.subarray(socketRead.length - 3)
  let released = 0

  incoming.push(tiny, () => { released++ })
  assert.equal(released, 0)
  const result = await incoming.next()
  assert.equal(result.done, false)
  assert.deepEqual(result.value, Buffer.from('aaa'))
  assert.equal(result.value.buffer.byteLength, tiny.byteLength)
  assert.equal(released, 1)
})

test('leaves immediate data and proportionate queued views zero-copy', async () => {
  const incoming = new IncomingStream(() => {})
  const socketRead = Buffer.alloc(64 * 1024)
  const pending = incoming.next()
  const tiny = socketRead.subarray(0, 3)
  let released = 0

  incoming.push(tiny, () => { released++ })
  assert.equal((await pending).value, tiny)
  assert.equal(released, 1)

  const large = socketRead.subarray(0, socketRead.length / 2)
  incoming.push(large, () => { released++ })
  assert.equal((await incoming.next()).value, large)
  assert.equal(released, 2)
})

test('rejects pending and subsequent reads without inspecting an error again', async () => {
  const incoming = new IncomingStream(() => {})
  let inspected = false
  const failure = new Proxy(new Error('stream failed'), {
    getPrototypeOf(target) {
      if (inspected) throw new Error('error prototype was inspected again')
      inspected = true
      return Reflect.getPrototypeOf(target)
    },
  })
  assert.ok(failure instanceof Error)

  const pending = incoming.next()
  incoming.fail(failure)
  await assert.rejects(pending, error => error === failure)
  await assert.rejects(incoming.next(), error => error === failure)
  await incoming.return()
  assert.deepEqual(await incoming.next(), { done: true, value: undefined })
})

test('a response finishes normally when its abort observer removal throws', { timeout: 5_000 }, async t => {
  /** @type {AbortSignal | undefined} */
  let observed
  const peer = await connect(t, [{
    name: 'response',
    mode: RpcMode.ServerStream,
    async *handle({ signal }) {
      observed = signal
      t.mock.method(signal, 'removeEventListener', () => {
        throw new Error('Abort listener tracing failed')
      })
      yield Buffer.from('response')
    },
  }])
  const response = peer.stream('response')
  assert.equal(String((await response.next()).value), 'response')
  assert.deepEqual(await response.next(), { done: true, value: undefined })
  assert.ok(observed)
  assert.equal(getEventListeners(observed, 'abort').length, 0)
})

test('an upload finishes normally when its abort observer removal throws', { timeout: 5_000 }, async t => {
  /** @type {AbortSignal | undefined} */
  let observed
  const peer = await connect(t, [{
    name: 'upload',
    mode: RpcMode.ClientStream,
    async handle({ input }) {
      const chunks = []
      for await (const chunk of input) chunks.push(chunk)
      return Buffer.concat(chunks)
    },
  }])

  const response = await peer.request('upload', {
    async *input(signal) {
      observed = signal
      t.mock.method(signal, 'removeEventListener', () => {
        throw new Error('Abort listener tracing failed')
      })
      yield Buffer.from('upload')
    },
  })
  assert.equal(String(response), 'upload')
  assert.ok(observed)
  assert.equal(getEventListeners(observed, 'abort').length, 0)
})

test('a failed abort observer setup returns the acquired iterator and removes the listener', { timeout: 5_000 }, async t => {
  /** @type {AbortSignal | undefined} */
  let observed
  let returned = 0
  const peer = await connect(t, [{
    name: 'response',
    mode: RpcMode.ServerStream,
    handle({ signal }) {
      observed = signal
      const add = signal.addEventListener
      t.mock.method(signal, 'addEventListener', function () {
        Reflect.apply(add, signal, arguments)
        throw new Error('Abort listener setup failed')
      })
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() { assert.fail('The producer should not be advanced') },
            async return() {
              returned++
              return { done: true, value: undefined }
            },
          }
        },
      }
    },
  }])

  await assert.rejects(peer.stream('response').next(), { code: 'INTERNAL', message: 'Abort listener setup failed' })
  assert.ok(observed)
  assert.equal(returned, 1)
  assert.equal(getEventListeners(observed, 'abort').length, 0)
})
