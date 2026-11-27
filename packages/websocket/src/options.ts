import type { WebSocketOptions } from './types.js'

export function integerOption(name: string, value: number, min: number, max = 2_147_483_647): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

export function resolveOptions(options: WebSocketOptions): Required<WebSocketOptions> {
  return {
    maxPayload: integerOption('maxPayload', options.maxPayload ?? 1024 * 1024, 1),
    maxBufferedBytes: integerOption('maxBufferedBytes', options.maxBufferedBytes ?? 4 * 1024 * 1024, 1),
    heartbeatIntervalMs: integerOption('heartbeatIntervalMs', options.heartbeatIntervalMs ?? 30_000, 0),
    handshakeTimeoutMs: integerOption('handshakeTimeoutMs', options.handshakeTimeoutMs ?? 5_000, 1),
    closeTimeoutMs: integerOption('closeTimeoutMs', options.closeTimeoutMs ?? 5_000, 0),
  }
}
