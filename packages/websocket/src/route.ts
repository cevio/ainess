import type { WebSocketRouteOptions } from './types.js'

export const namedEndpoint = Symbol('namedEndpoint')
export const registerRoute = Symbol('registerRoute')

export type TransportRoute<State> = WebSocketRouteOptions<State> & { readonly [namedEndpoint]?: true }

export function assertRoutePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !/^\/[^\s?#]*$/u.test(path)) {
    throw new TypeError('WebSocket route paths must start with / and cannot contain whitespace, ? or #')
  }
}
