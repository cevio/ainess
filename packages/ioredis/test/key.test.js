import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { redisKeyPart } from '../dist/capabilities.js'

test('Redis key digests preserve the original UTF-16 code units', () => {
  const codeUnits = Buffer.from([0x61, 0x00, 0x00, 0xd8])
  const expected = createHash('sha256').update(codeUnits).digest('hex')
  assert.equal(redisKeyPart('a\uD800', 'key'), expected)
  assert.notEqual(redisKeyPart('a\uFFFD', 'key'), expected)
})
