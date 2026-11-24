import type findMyWay from 'find-my-way'
import type { HttpMethod, HttpRouteMiddleware } from './index.js'

export const registerRoute = Symbol('registerRoute')

export type HttpRouter = findMyWay.Instance<findMyWay.HTTPVersion.V1>

interface RegisteredRoute {
  handle: HttpRouteMiddleware
  catchAll?: { name: string; depth: number }
}

type MatchedRoute = Omit<findMyWay.FindResult<findMyWay.HTTPVersion.V1>, 'store'> & { store: RegisteredRoute }

const allFileRoutes = { fileCatchAllDepth: Infinity }
const fileCatchAll: findMyWay.ConstraintStrategy<findMyWay.HTTPVersion.V1> = {
  name: 'fileCatchAllDepth',
  deriveConstraint: () => 'Infinity',
  storage() {
    let depth = Infinity
    let handler: findMyWay.Handler<findMyWay.HTTPVersion.V1> | null = null
    return {
      get(maxDepth) {
        return Number(maxDepth) >= depth ? handler : null
      },
      set(value, match) {
        depth = Number(value)
        handler = match
      },
    }
  },
}

function wildcardDepth(path: string): number {
  return path.split('/').filter(Boolean).length - 1
}

export function registerHttpRoute(
  router: HttpRouter,
  method: HttpMethod,
  path: string,
  handle: HttpRouteMiddleware,
  catchAllName?: string,
): () => void {
  const catchAll = catchAllName ? { name: catchAllName, depth: wildcardDepth(path) } : undefined
  const hasFileCatchAll = router.hasConstraintStrategy(fileCatchAll.name)
  if (catchAll || (hasFileCatchAll && path.includes('*'))) {
    // Keep a wildcard's route key exclusive across explicit routes and file routes.
    const conflicting = catchAll ? undefined : { fileCatchAllDepth: wildcardDepth(path) }
    if (router.hasRoute(method, path, conflicting)) {
      throw new Error(`Method '${method}' already declared for route '${path}'`)
    }
  }
  if (catchAll && !hasFileCatchAll) router.addConstraintStrategy(fileCatchAll)

  const constraints = catchAll && { fileCatchAllDepth: catchAll.depth }
  const store: RegisteredRoute = { handle, catchAll }
  router.on(method, path, { constraints }, () => {}, store)
  return () => router.off(method, path, constraints)
}

export function findRoute(router: HttpRouter, method: HttpMethod, path: string): MatchedRoute | null {
  const constraints = router.hasConstraintStrategy(fileCatchAll.name) ? allFileRoutes : undefined
  let route = router.find(method, path, constraints) as MatchedRoute | null
  if (route?.store.catchAll && !route.params['*']) {
    // An empty wildcard consumes no path after its prefix. A shallower wildcard still consumes that path.
    route = router.find(method, path, { fileCatchAllDepth: route.store.catchAll.depth - 1 }) as MatchedRoute | null
  }
  if (route?.store.catchAll) {
    route.params[route.store.catchAll.name] = route.params['*']
    delete route.params['*']
  }
  return route
}
