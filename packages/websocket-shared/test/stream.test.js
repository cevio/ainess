import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import test from 'node:test'
import { pumpWebSocketStream, WebSocketStreamQueue } from '@ainess/websocket-shared'

test('delivers chunks to concurrent readers in order and ends the remaining reads', async () => {
  const queue = new WebSocketStreamQueue()
  const chunks = [undefined, ...Array.from({ length: 2_048 }, (_, index) => index)]
  const pending = Array.from({ length: chunks.length + 2 }, () => queue.next())
  for (const chunk of chunks) queue.push(chunk)
  queue.end()
  const results = await Promise.all(pending)
  assert.deepEqual(results.slice(0, chunks.length), chunks.map(value => ({ value, done: false })))
  assert.deepEqual(results.slice(chunks.length), [
    { value: undefined, done: true },
    { value: undefined, done: true },
  ])
})

test('cancelling a blocked write releases the iterator before the write settles', { timeout: 4_000 }, async (t) => {
  const events = new EventEmitter()
  const controller = new AbortController()
  const reason = new Error('Upload stopped')
  t.after(() => { events.emit('flush') })
  /** @type {AsyncIterable<number>} */
  const source = {
    [Symbol.asyncIterator]() {
      return {
        async next() { return { value: 1, done: false } },
        async return() {
          events.emit('released')
          return { value: undefined, done: true }
        },
      }
    },
  }
  const written = once(events, 'writing')
  const wait = new AbortController()
  const timer = setTimeout(() => wait.abort(), 1_500)
  t.after(() => { clearTimeout(timer) })
  const released = once(events, 'released', { signal: wait.signal })
  const outcome = pumpWebSocketStream(source, controller.signal, async (value) => {
    assert.equal(value, 1)
    const flushed = once(events, 'flush')
    events.emit('writing')
    await flushed
  }).then(() => undefined, error => error)
  await written
  controller.abort(reason)
  await released
  assert.equal(await outcome, reason)
})

test('a cancelled stream does not start the producer', async (t) => {
  const create = t.mock.fn(() => { throw new Error('Unexpected iterator creation') })
  const source = { [Symbol.asyncIterator]: create }
  const reason = new Error('Upload never started')
  await assert.rejects(pumpWebSocketStream(source, AbortSignal.abort(reason), () => {}), reason)
  assert.equal(create.mock.callCount(), 0)
})
