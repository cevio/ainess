import { Buffer, isUtf8 } from 'node:buffer'
import { RpcError } from './types.js'
import type { Bytes, RpcErrorCode } from './types.js'
import { EMPTY, encodeHeader, FrameType, HEADER_SIZE, MAX_BODY } from './wire.js'
import type { Frame } from './wire.js'

const errorCodes = [
  'CANCELLED',
  'DEADLINE_EXCEEDED',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
  'INTERNAL',
] as const satisfies readonly RpcErrorCode[]

export function frame(type: FrameType, id: number, body: Buffer = EMPTY, flags = 0): Frame {
  return { type, id, body, flags }
}

export function invalidProtocol(message: string): never {
  throw new RpcError('UNAVAILABLE', message)
}

export function byteBody(data: Bytes, prefix = 0): Buffer {
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_BODY - prefix) {
    throw new RpcError('INVALID_ARGUMENT', `Expected a byte payload of at most ${MAX_BODY - prefix} bytes`)
  }
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

export function methodNameLength(name: string): number {
  const length = typeof name === 'string' && name.length <= 0xff ? Buffer.byteLength(name) : 0
  if (length === 0 || length > 0xff || (length !== name.length && /[\ud800-\udfff]/u.test(name))) {
    throw new RpcError('INVALID_ARGUMENT', 'RPC method name must contain 1 to 255 bytes of UTF-8')
  }
  return length
}

export function openFrame(id: number, name: string, data: Bytes, flags = 0): Frame {
  const length = methodNameLength(name)
  const offset = 1 + length
  const payload = byteBody(data, offset)
  const packet = Buffer.allocUnsafe(HEADER_SIZE + offset + payload.length)
  const body = packet.subarray(HEADER_SIZE)
  body[0] = length
  body.write(name, 1, length, 'utf8')
  body.set(payload, offset)
  const value = { type: FrameType.Open, id, flags, body, packet }
  encodeHeader(value, packet)
  return value
}

export function readOpenBody(body: Buffer): { name: string; data: Buffer } {
  const length = body[0] ?? 0
  const offset = 1 + length
  if (length === 0 || offset > body.length) invalidProtocol('Invalid RPC method name length')
  const name = body.toString('utf8', 1, offset)
  // Invalid byte sequences decode to U+FFFD, which is also a valid name character.
  if (name.includes('\ufffd') && !isUtf8(body.subarray(1, offset))) {
    invalidProtocol('Invalid UTF-8 in RPC method name')
  }
  return { name, data: body.subarray(offset) }
}

export function errorFrame(id: number, error: unknown): Frame {
  let code = -1
  let message = 'RPC handler failed'
  try {
    if (error instanceof RpcError) code = errorCodes.indexOf(error.code)
    if (error instanceof Error) {
      const detail = error.message
      if (typeof detail === 'string') message = detail
    }
  } catch {
    // Thrown errors can expose accessors that fail during serialization.
  }
  const body = Buffer.allocUnsafe(1026)
  body.writeUInt16BE(code < 0 ? errorCodes.length : code + 1)
  const length = body.write(message, 2, 1024)
  return frame(FrameType.Error, id, body.subarray(0, length + 2))
}

export function readError(body: Buffer): RpcError {
  const code = errorCodes[body.readUInt16BE() - 1]
  if (!code) invalidProtocol('Invalid RPC error code')
  return new RpcError(code, body.toString('utf8', 2))
}
