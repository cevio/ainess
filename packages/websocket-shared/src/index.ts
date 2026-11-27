export { WebSocketStreamQueue, pumpWebSocketStream, waitWithAbort } from './stream.js'

export enum WebSocketMethodMode {
  Unary = 0b00,
  ClientStream = 0b01,
  ServerStream = 0b10,
  Bidi = 0b11,
}

export type WebSocketFrame =
  | { type: 'event', name: string, data?: unknown }
  | { type: 'call', id: string, name: string, mode: WebSocketMethodMode, data?: unknown }
  | { type: 'chunk', id: string, data?: unknown }
  | { type: 'result', id: string, data?: unknown }
  | { type: 'input-end', id: string }
  | { type: 'end', id: string }
  | { type: 'cancel', id: string }
  | { type: 'error', id: string, error: { code: string, message: string } }

export class WebSocketEndpointError extends Error {
  constructor(readonly code: string, message = code, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WebSocketEndpointError'
  }
}

export function isWebSocketMethodMode(value: unknown): value is WebSocketMethodMode {
  return value === WebSocketMethodMode.Unary || value === WebSocketMethodMode.ClientStream
    || value === WebSocketMethodMode.ServerStream || value === WebSocketMethodMode.Bidi
}

export function hasStreamingInput(mode: WebSocketMethodMode): boolean {
  return (mode & WebSocketMethodMode.ClientStream) !== 0
}

export function hasStreamingOutput(mode: WebSocketMethodMode): boolean {
  return (mode & WebSocketMethodMode.ServerStream) !== 0
}

function invalid(message: string): never {
  throw new WebSocketEndpointError('PROTOCOL_ERROR', message)
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('Expected a JSON object')
  return input as Record<string, unknown>
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length) invalid(`Expected a non-empty ${field}`)
  return value
}

export function decodeWebSocketFrame(message: string | Uint8Array): WebSocketFrame {
  if (typeof message !== 'string') invalid('Expected a WebSocket text message')
  let decoded: unknown
  try {
    decoded = JSON.parse(message)
  } catch (cause) {
    throw new WebSocketEndpointError('PROTOCOL_ERROR', 'Invalid WebSocket frame JSON', { cause })
  }
  const { type, name, mode, data, error, id } = record(decoded)
  if (type === 'event') return { type, name: nonEmptyString(name, 'event name'), data }
  if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) invalid('Expected a positive decimal call ID')

  switch (type) {
    case 'call': {
      const kind = mode === undefined ? WebSocketMethodMode.Unary : mode
      if (!isWebSocketMethodMode(kind)) invalid('Invalid WebSocket method mode')
      return { type, id, name: nonEmptyString(name, 'method name'), mode: kind, data }
    }
    case 'chunk':
    case 'result':
      return { type, id, data }
    case 'input-end':
    case 'end':
    case 'cancel':
      return { type, id }
    case 'error': {
      const { code, message } = record(error)
      if (typeof message !== 'string') invalid('Expected an error message')
      return { type, id, error: { code: nonEmptyString(code, 'error code'), message } }
    }
    default:
      invalid('Unknown WebSocket frame type')
  }
}

export function encodeWebSocketFrame(frame: WebSocketFrame): string {
  return JSON.stringify(frame)
}
