import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeWebSocketFrame, encodeWebSocketFrame, hasStreamingInput, hasStreamingOutput, WebSocketMethodMode,
} from '@ainess/websocket-shared'

test('uses the RPC mode layout and preserves the mode on the JSON wire', () => {
  assert.deepEqual([
    WebSocketMethodMode.Unary,
    WebSocketMethodMode.ClientStream,
    WebSocketMethodMode.ServerStream,
    WebSocketMethodMode.Bidi,
  ], [0, 1, 2, 3])
  /** @type {import('@ainess/websocket-shared').WebSocketFrame} */
  const call = { type: 'call', id: '1', name: 'echo', mode: WebSocketMethodMode.Bidi, data: { value: 1 } }
  assert.deepEqual(decodeWebSocketFrame(encodeWebSocketFrame(call)), call)
  assert.equal(hasStreamingInput(WebSocketMethodMode.Unary), false)
  assert.equal(hasStreamingInput(WebSocketMethodMode.ClientStream), true)
  assert.equal(hasStreamingOutput(WebSocketMethodMode.ServerStream), true)
  assert.equal(hasStreamingOutput(WebSocketMethodMode.ClientStream), false)
})

test('rejects malformed JSON and rejects flow-control frames', () => {
  for (const message of ['{', '{"type":"credit","id":"1"}', '{"type":"call","id":"1","name":"x","mode":7}']) {
    assert.throws(() => decodeWebSocketFrame(message), { code: 'PROTOCOL_ERROR' })
  }
})
