import assert from 'node:assert/strict'
import test from 'node:test'
import { IncomingStream } from '../dist/stream.js'

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
