import type { RpcPeer } from './peer.js'

export enum RpcMode {
  Unary = 0b00,
  ClientStream = 0b01,
  ServerStream = 0b10,
  Bidi = 0b11,
}

export type Bytes = Uint8Array
export type ByteStream = AsyncIterable<Bytes>

export interface RpcAddress {
  host: string
  port: number
}

export interface RpcCallOptions {
  input?: (signal: AbortSignal) => ByteStream
  signal?: AbortSignal
  timeoutMs?: number
}

export interface RpcInput extends ByteStream {
  stop(): void
}

export interface RpcCall {
  peer: RpcPeer
  data: Bytes
  signal: AbortSignal
}

export interface RpcStreamingCall extends RpcCall {
  input: RpcInput
}

type Handler<Call, Result> = (call: Call) => Result | Promise<Result>

export type RpcMethod = { name: string } & (
  | { mode: RpcMode.Unary; handle: Handler<RpcCall, Bytes> }
  | { mode: RpcMode.ClientStream; handle: Handler<RpcStreamingCall, Bytes> }
  | { mode: RpcMode.ServerStream; handle: Handler<RpcCall, ByteStream> }
  | { mode: RpcMode.Bidi; handle: Handler<RpcStreamingCall, ByteStream> }
)

export type RpcErrorCode =
  | 'CANCELLED'
  | 'DEADLINE_EXCEEDED'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'RESOURCE_EXHAUSTED'
  | 'UNAVAILABLE'
  | 'INTERNAL'

export class RpcError extends Error {
  constructor(readonly code: RpcErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RpcError'
  }
}
