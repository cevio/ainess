import type findMyWay from 'find-my-way'
import type { HttpMethod, HttpRouteMiddleware } from './index.js'

export const registerRoute = Symbol('registerRoute')

export type HttpRouter = findMyWay.Instance<findMyWay.HTTPVersion.V1>

export interface RegisteredRoute {
  handle: HttpRouteMiddleware
  catchAllName?: string
}

type MatchedRoute = Omit<findMyWay.FindResult<findMyWay.HTTPVersion.V1>, 'store'> & { store: RegisteredRoute }

export function findRoute(router: HttpRouter, method: HttpMethod, path: string): MatchedRoute | null {
  const route = router.find(method, path) as MatchedRoute | null
  const name = route?.store.catchAllName
  if (route && name) {
    const value = route.params['*']
    if (!value) return null
    route.params[name] = value
    delete route.params['*']
  }
  return route
}
