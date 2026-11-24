import type { AddressInfo } from 'node:net'
import { Service, type Context, type Disposable } from '@deepseek-ai/cordis'
import findMyWay from 'find-my-way'
import Koa from 'koa'
import compose from 'koa-compose'
import { createListener, type HttpHandler, type HttpListenerOptions } from './listener.js'
import { findRoute, registerHttpRoute, registerRoute, type HttpRouter } from './route.js'

export { defineController, type HttpControllerInput, type HttpControllerOptions } from './controller.js'
export type { HttpHandler, HttpListenerOptions, HttpPrepare, PreparedHttp } from './listener.js'

export type HttpMethod = findMyWay.HTTPMethod
export type HttpRouteMiddleware = Koa.Middleware<Koa.DefaultState, { params: Record<string, string | undefined> }>

export interface HttpOptions {
  koa?: ConstructorParameters<typeof Koa>[0]
  router?: Pick<findMyWay.Config<findMyWay.HTTPVersion.V1>,
    'caseSensitive' | 'ignoreTrailingSlash' | 'ignoreDuplicateSlashes' | 'maxParamLength'>
}

const startListener = Symbol('startListener')

function canUseRouteFallback(request: Koa.Context): boolean {
  // Koa's initial 404 leaves this flag unset. Assigning ctx.status claims the response.
  return request.status === 404 && request.body === undefined && !Reflect.get(request.response, '_explicitStatus')
    && request.respond !== false && request.writable && !request.headerSent
    && !request.req.readableDidRead && request.req.readableFlowing !== true
}

class Http extends Service {
  private readonly handle: HttpHandler
  private readonly middleware = new Map<symbol, Koa.Middleware>()
  private readonly router: HttpRouter
  private readonly state: {
    chain: Koa.Middleware
    listener?: ReturnType<typeof createListener>
  } = { chain: compose([]) }

  constructor(ctx: Context, options: HttpOptions = {}) {
    super(ctx, 'http')
    const koa = new Koa(options.koa)
    const router = this.router = findMyWay(options.router)
    koa.use(async (request, next) => {
      const fallback = this.state.listener?.onRouteMiss
      let missed = false
      await this.state.chain(request, async () => {
        const method = request.method as HttpMethod
        const path = request.path
        const route = findRoute(router, method, path) ?? (method === 'HEAD' ? findRoute(router, 'GET', path) : null)
        if (route) return route.store.handle(Object.assign(request, { params: route.params }), next)
        missed = true
        return next()
      })
      if (fallback && missed && canUseRouteFallback(request)) {
        request.respond = false
        // Reset Koa's default status and let Node choose the final reason phrase.
        request.res.statusCode = 200
        await fallback(request.req, request.res)
      }
    })
    this.handle = koa.callback()
  }

  use(middleware: Koa.Middleware): void {
    if (typeof middleware !== 'function') throw new TypeError('HTTP middleware must be a function')
    const id = Symbol()
    const { middleware: registered, state } = this
    this.ctx.effect(() => {
      registered.set(id, middleware)
      state.chain = compose([...registered.values()])
      return () => {
        registered.delete(id)
        state.chain = compose([...registered.values()])
      }
    }, 'http.use()')
  }

  route(
    method: HttpMethod,
    path: string,
    ...middleware: [HttpRouteMiddleware, ...HttpRouteMiddleware[]]
  ): Disposable<void | Promise<void>> {
    return this[registerRoute](method, path, middleware)
  }

  [registerRoute](
    method: HttpMethod,
    path: string,
    middleware: HttpRouteMiddleware[],
    catchAllName?: string,
  ): Disposable<void | Promise<void>> {
    if (typeof method !== 'string') throw new TypeError('An HTTP route must use one method')
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('?') || path.includes('#')) {
      throw new TypeError('HTTP route paths must start with / and cannot contain ? or #')
    }
    if (!middleware.length) throw new TypeError('An HTTP route requires at least one middleware')
    const { router } = this
    const handle = compose(middleware)
    return this.ctx.effect(
      () => registerHttpRoute(router, method, path, handle, catchAllName),
      `http.route(${method} ${path})`,
    )
  }

  address(): AddressInfo | null {
    const address = this.state.listener?.server.address()
    return address && typeof address !== 'string' ? address : null
  }

  async [startListener](ctx: Context, options: HttpListenerOptions): Promise<() => Promise<void>> {
    const { state } = this
    if (state.listener) throw new Error('The HTTP service already has a listener')

    const reportError = (error: unknown) => ctx.logger.error(error)
    const listener = createListener(options, reportError)
    state.listener = listener
    const close = () => listener.close().finally(() => {
      if (state.listener === listener) state.listener = undefined
    })
    const startup = new AbortController()
    const stopWatchingDisposal = ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) startup.abort()
    })
    const stopWatchingService = ctx.on('internal/service', (name) => {
      if (name === 'http' && ctx.get('http')?.state !== state) startup.abort()
    })

    try {
      await listener.open(this.handle, startup.signal)
      if (startup.signal.aborted) await close()
    } catch (error) {
      await close().catch(reportError)
      if (!startup.signal.aborted) throw error
    } finally {
      stopWatchingDisposal()
      stopWatchingService()
    }
    return close
  }
}

export { Http as http }
export type HttpService = Pick<Http, 'use' | 'route' | 'address'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly http: Http
  }
}

export const httpListener = {
  name: 'http-listener',
  inject: ['http'],
  async apply(ctx: Context, options: HttpListenerOptions): Promise<void> {
    await ctx.effect(() => ctx.http[startListener](ctx, options), 'http.listen()')
  },
}
