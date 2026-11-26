import assert from 'node:assert/strict'
import test from 'node:test'
import { rpcPayloadLimit } from '@ainess/rpc'
import { openFrame } from '../dist/messages.js'
import {
  EMPTY,
  FrameDecoder,
  FrameType,
  HEADER_SIZE,
  LIMITS,
  MAX_BODY,
  decodeHello,
  encodeHeader,
  encodeHello,
} from '../dist/wire.js'

/** @typedef {import('../dist/wire.js').Frame} Frame */

/** @param {Frame[]} frames */
function encodeFrames(frames) {
  return Buffer.concat(frames.flatMap(frame => [encodeHeader(frame), frame.body]))
}

/** @type {Frame[]} */
const frames = [
  { type: FrameType.Open, id: 0x01020304, flags: 3, body: Buffer.from([1, 2, 3]) },
  { type: FrameType.Data, id: 0x01020304, flags: 0, body: Buffer.from([8, 9]) },
  { type: FrameType.EndInput, id: 0x01020304, flags: 0, body: EMPTY },
]

test('encodes the fixed 12-byte big-endian frame header', () => {
  assert.deepEqual([...encodeHeader(frames[0])], [0, 0, 0, 3, 1, 2, 3, 4, 2, 3, 0, 0])
})

test('reports the payload limit for a UTF-8 method name and full-size data frames', () => {
  const method = '订单.查询'
  const limit = rpcPayloadLimit(method)
  assert.equal(rpcPayloadLimit(), MAX_BODY)
  assert.equal(openFrame(1, method, Buffer.alloc(limit)).body.byteLength, MAX_BODY)
  assert.throws(() => openFrame(1, method, Buffer.alloc(limit + 1)), { code: 'INVALID_ARGUMENT' })
  assert.throws(() => rpcPayloadLimit(''), { code: 'INVALID_ARGUMENT' })
})

test('decodes all frames in order for every split of a coalesced TCP read', () => {
  const bytes = encodeFrames(frames)
  for (let split = 0; split <= bytes.length; split++) {
    const decoder = new FrameDecoder()
    /** @type {Frame[]} */
    const decoded = []
    decoder.push(bytes.subarray(0, split), frame => decoded.push(frame))
    decoder.push(bytes.subarray(split), frame => decoded.push(frame))
    assert.deepEqual(decoded, frames, `split at byte ${split}`)
    assert.equal(decoder.incomplete, false)
  }
})

test('keeps the header and body state across consecutive single-byte TCP reads', () => {
  const decoder = new FrameDecoder()
  const bytes = encodeFrames(frames)
  /** @type {Frame[]} */
  const decoded = []
  let completeLength = 0
  const frameBoundaries = new Set(frames.map(frame => {
    completeLength += HEADER_SIZE + frame.body.length
    return completeLength
  }))

  for (let offset = 0; offset < bytes.length; offset++) {
    decoder.push(bytes.subarray(offset, offset + 1), frame => decoded.push(frame))
    assert.equal(decoder.incomplete, !frameBoundaries.has(offset + 1))
  }
  assert.deepEqual(decoded, frames)
})

test('uses a byte view when a body arrives in one read after its header', () => {
  const decoder = new FrameDecoder()
  decoder.push(encodeHeader(frames[0]), () => assert.fail('body is incomplete'))
  assert.equal(decoder.incomplete, true)

  const body = Buffer.from(frames[0].body)
  decoder.push(body, (frame) => {
    assert.equal(frame.body.buffer, body.buffer)
    assert.equal(frame.body.byteOffset, body.byteOffset)
    assert.deepEqual(frame, frames[0])
  })
  assert.equal(decoder.incomplete, false)
})

test('rejects invalid headers as soon as the header is complete', () => {
  const oversized = encodeHeader(frames[0])
  oversized.writeUInt32BE(MAX_BODY + 1)
  const unknownType = encodeHeader(frames[0])
  unknownType.writeUInt8(255, 8)
  const reservedBits = encodeHeader(frames[0])
  reservedBits.writeUInt16BE(1, 10)

  for (const header of [oversized, unknownType, reservedBits]) {
    assert.throws(() => new FrameDecoder().push(header, () => assert.fail('invalid header was accepted')))
  }
})

test('HELLO contains only a frame size and three credit windows', () => {
  const hello = encodeHello()
  assert.equal(hello.byteLength, 16)
  assert.deepEqual([0, 4, 8, 12].map(offset => hello.readUInt32BE(offset)), [
    MAX_BODY, LIMITS.messageWindow, LIMITS.streamWindow, LIMITS.callWindow,
  ])
  assert.deepEqual(decodeHello(hello), LIMITS)
  assert.throws(() => decodeHello(hello.subarray(1)))
  assert.throws(() => decodeHello(Buffer.concat([hello, Buffer.alloc(2)])), /Incompatible RPC HELLO/)

  const wrongBodySize = Buffer.from(hello)
  wrongBodySize.writeUInt32BE(MAX_BODY - 1, 0)
  assert.throws(() => decodeHello(wrongBodySize))

  for (const [offset, limit] of [[4, MAX_BODY], [8, 0xffffffff], [12, 0]]) {
    const invalid = Buffer.from(hello)
    invalid.writeUInt32BE(limit, offset)
    assert.throws(() => decodeHello(invalid))
  }
})
