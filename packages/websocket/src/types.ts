import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

export interface Upgrade {
  readonly request: IncomingMessage
  readonly socket: Duplex
  readonly head: Buffer
  readonly signal?: AbortSignal
}

export type WebSocketMessage = string | Uint8Array

export interface WebSocketHandshake {
  readonly request: IncomingMessage
  readonly signal: AbortSignal
}

export type WebSocketAuthorization<State> =
  | { accept: true, state: State }
  | { accept: false, status: 400 | 401 | 403 | 429 }

export type WebSocketAuthorize<State> = (
  handshake: WebSocketHandshake,
) => WebSocketAuthorization<State> | Promise<WebSocketAuthorization<State>>

export interface WebSocketConnection<State = undefined> {
  readonly state: State
  readonly signal: AbortSignal
  send(message: WebSocketMessage): Promise<void>
  close(code?: number, reason?: string): void
}

export interface WebSocketCloseInfo {
  readonly code: number
  readonly reason: string
}

export interface WebSocketRouteOptions<State> {
  authorize?: WebSocketAuthorize<State>
  onOpen?(connection: WebSocketConnection<State>): void | Promise<void>
  onMessage?(connection: WebSocketConnection<State>, message: WebSocketMessage): void | Promise<void>
  onClose?(connection: WebSocketConnection<State>, info: WebSocketCloseInfo): void | Promise<void>
}

export type WebSocketRoute<State = undefined> = [State] extends [undefined]
  ? WebSocketRouteOptions<State>
  : WebSocketRouteOptions<State> & { authorize: WebSocketAuthorize<State> }

export interface WebSocketOptions {
  maxPayload?: number
  maxBufferedBytes?: number
  heartbeatIntervalMs?: number
  handshakeTimeoutMs?: number
  closeTimeoutMs?: number
}

export interface WebSocketListenerOptions {
  port: number
  host?: string
  shutdownTimeoutMs?: number
}
