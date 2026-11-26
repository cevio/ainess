import { Buffer } from 'node:buffer'

export enum FrameType {
  Hello = 1,
  Open = 2,
  Data = 3,
  EndInput = 4,
  End = 5,
  Error = 6,
  WindowUpdate = 7,
  StopInput = 8,
  Cancel = 9,
}

export interface Frame {
  type: FrameType
  id: number
  flags: number
  body: Buffer
  packet?: Buffer
}

export const HEADER_SIZE = 12
export const MAX_BODY = 64 * 1024
export const MAX_CALL_ID = 0xffffffff
export const EMPTY = Buffer.alloc(0)

export function encodeHeader(frame: Frame, header: Buffer = Buffer.allocUnsafe(HEADER_SIZE)): Buffer {
  if (frame.body.length > MAX_BODY) throw new RangeError('RPC frame body exceeds the size limit')
  header.writeUInt32BE(frame.body.length, 0)
  header.writeUInt32BE(frame.id, 4)
  header[8] = frame.type
  header[9] = frame.flags
  header[10] = 0
  header[11] = 0
  return header
}

export class FrameDecoder {
  #header = Buffer.allocUnsafe(HEADER_SIZE)
  #headerUsed = 0
  #frame: Frame | undefined
  #length = 0
  #bodyUsed = 0

  get incomplete(): boolean {
    return this.#headerUsed !== 0 || this.#frame !== undefined
  }

  push(chunk: Buffer, onFrame: (frame: Frame, more: boolean) => void): void {
    let offset = 0
    while (offset < chunk.length) {
      if (!this.#frame) {
        offset = this.#readHeader(chunk, offset)
        if (!this.#frame) return
      }

      const frame = this.#frame
      const available = chunk.length - offset
      if (this.#bodyUsed === 0 && available >= this.#length) {
        if (this.#length > 0) frame.body = chunk.subarray(offset, offset + this.#length)
        offset += this.#length
      } else {
        if (available === 0) return
        if (this.#bodyUsed === 0) frame.body = Buffer.allocUnsafe(this.#length)
        const count = Math.min(available, this.#length - this.#bodyUsed)
        chunk.copy(frame.body, this.#bodyUsed, offset, offset + count)
        this.#bodyUsed += count
        offset += count
        if (this.#bodyUsed < this.#length) return
      }

      this.#frame = undefined
      this.#bodyUsed = 0
      onFrame(frame, chunk.length - offset >= HEADER_SIZE)
    }
  }

  #readHeader(chunk: Buffer, offset: number): number {
    if (this.#headerUsed === 0 && chunk.length - offset >= HEADER_SIZE) {
      this.#parseHeader(chunk, offset)
      return offset + HEADER_SIZE
    }

    const count = Math.min(chunk.length - offset, HEADER_SIZE - this.#headerUsed)
    chunk.copy(this.#header, this.#headerUsed, offset, offset + count)
    this.#headerUsed += count
    if (this.#headerUsed === HEADER_SIZE) {
      this.#parseHeader(this.#header, 0)
      this.#headerUsed = 0
    }
    return offset + count
  }

  #parseHeader(header: Buffer, offset: number): void {
    const length = header.readUInt32BE(offset)
    const type = header.readUInt8(offset + 8)
    if (length > MAX_BODY) throw new RangeError('RPC frame body exceeds the size limit')
    if (type < FrameType.Hello || type > FrameType.Cancel) throw new Error('Unknown RPC frame type')
    if (header.readUInt16BE(offset + 10) !== 0) throw new Error('Reserved RPC header bits must be zero')

    this.#length = length
    this.#frame = { type, id: header.readUInt32BE(offset + 4), flags: header.readUInt8(offset + 9), body: EMPTY }
  }
}

export interface Limits {
  messageWindow: number
  streamWindow: number
  callWindow: number
}

export const LIMITS: Readonly<Limits> = Object.freeze({
  messageWindow: 1024 * 1024,
  streamWindow: 4 * 1024 * 1024,
  callWindow: 4 * (MAX_BODY + HEADER_SIZE),
})

const HELLO_SIZE = 16
const MAX_WINDOW = 64 * 1024 * 1024
export function encodeHello(): Buffer {
  const hello = Buffer.allocUnsafe(HELLO_SIZE)
  hello.writeUInt32BE(MAX_BODY, 0)
  hello.writeUInt32BE(LIMITS.messageWindow, 4)
  hello.writeUInt32BE(LIMITS.streamWindow, 8)
  hello.writeUInt32BE(LIMITS.callWindow, 12)
  return hello
}

export function decodeHello(body: Buffer): Limits {
  if (body.length !== HELLO_SIZE || body.readUInt32BE(0) !== MAX_BODY) {
    throw new Error('Incompatible RPC HELLO')
  }
  const messageWindow = body.readUInt32BE(4)
  const streamWindow = body.readUInt32BE(8)
  const callWindow = body.readUInt32BE(12)
  const minWindow = MAX_BODY + HEADER_SIZE
  if (messageWindow < minWindow || messageWindow > MAX_WINDOW
    || streamWindow < minWindow || streamWindow > MAX_WINDOW
    || callWindow < minWindow || callWindow > streamWindow) {
    throw new Error('Invalid RPC HELLO limits')
  }
  return { messageWindow, streamWindow, callWindow }
}

export function writeUint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4)
  bytes.writeUInt32BE(value)
  return bytes
}
