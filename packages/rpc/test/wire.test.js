import assert from 'node:assert/strict'
import test from 'node:test'
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

test('HELLO round-trips valid receive limits and rejects incompatible or unsafe limits', () => {
  const hello = encodeHello()
  assert.deepEqual(decodeHello(hello), LIMITS)
  assert.throws(() => decodeHello(hello.subarray(1)))

  const unilateralVersion = Buffer.from(hello)
  unilateralVersion.writeUInt16BE(1, 0)
  assert.throws(() => decodeHello(unilateralVersion), /Incompatible RPC HELLO/)

  const wrongBodySize = Buffer.from(hello)
  wrongBodySize.writeUInt32BE(MAX_BODY - 1, 2)
  assert.throws(() => decodeHello(wrongBodySize))

  for (const [offset, limit] of [[6, MAX_BODY], [10, 0xffffffff], [14, 0], [18, 0]]) {
    const invalid = Buffer.from(hello)
    invalid.writeUInt32BE(limit, offset)
    assert.throws(() => decodeHello(invalid))
  }
})
