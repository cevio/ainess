import type { AddressInfo } from 'node:net'
import { Service, type Context, type Disposable } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import { closePeers, openPeer, type Peer } from './connection.js'
import { createListener, type Ingress } from './listener.js'
import { resolveOptions } from './options.js'
import { assertRoutePath, namedEndpoint, registerRoute, type TransportRoute } from './route.js'
import type {
  WebSocketAuthorize,
  WebSocketListenerOptions,
  WebSocketOptions,
  WebSocketRoute,
  WebSocketRouteOptions,
} from './types.js'

export const createIngress = Symbol('createIngress')
const startListener = Symbol('startListener')

interface Route {
  readonly endpoint: TransportRoute<unknown>
  readonly peers: Set<Peer>
}

export class Websocket extends Service {
  private readonly options: Required<WebSocketOptions>
  private readonly engine: WebSocketServer
  private namedEngine?: WebSocketServer
  private readonly routes = new Map<string, Route>()
  private readonly peers = new Set<Peer>()
  private readonly state: { stopped: boolean, listener?: ReturnType<typeof createListener> } = { stopped: false }
  private readonly reportError: (error: unknown) => void

  constructor(ctx: Context, options: WebSocketOptions = {}) {
    super(ctx, 'websocket')
    this.options = resolveOptions(options)
    this.reportError = (error) => ctx.logger.error(error)
    this.engine = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: this.options.maxPayload,
      perMessageDeflate: false,
    })
    ctx.effect(() => {
      const interval = this.options.heartbeatIntervalMs
      const heartbeat = interval && setInterval(() => {
        for (const peer of this.peers) peer.heartbeat()
      }, interval).unref()
      return async () => {
        this.state.stopped = true
        if (heartbeat) clearInterval(heartbeat)
        await closePeers(this.peers, this.options.closeTimeoutMs)
        await Promise.all([this.engine, this.namedEngine].map(engine => {
          if (engine) return new Promise<void>((resolve) => engine.close(() => resolve()))
        }))
      }
    }, 'websocket.connections')
  }

  route<State>(
    path: string,
    endpoint: WebSocketRouteOptions<State> & { authorize: WebSocketAuthorize<State> },
  ): Disposable<Promise<void>>
  route(path: string, endpoint: WebSocketRoute): Disposable<Promise<void>>
  route(path: string, endpoint: TransportRoute<unknown>): Disposable<Promise<void>> {
    assertRoutePath(path)
    return this[registerRoute](path, endpoint)
  }

  [registerRoute](path: string, endpoint: unknown): Disposable<Promise<void>> {
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
      throw new TypeError('A WebSocket endpoint must be an object')
    }
    const { authorize, onOpen, onMessage, onClose, [namedEndpoint]: named } = endpoint as TransportRoute<unknown>
    for (const [name, callback] of Object.entries({ authorize, onOpen, onMessage, onClose })) {
      if (callback !== undefined && typeof callback !== 'function') throw new TypeError(`${name} must be a function`)
    }
    const { routes, options } = this
    return this.ctx.effect(() => {
      if (routes.has(path)) throw new Error(`WebSocket route ${path} is already registered`)
      const route: Route = {
        endpoint: { authorize, onOpen, onMessage, onClose, [namedEndpoint]: named },
        peers: new Set(),
      }
      routes.set(path, route)
      return () => {
        if (routes.get(path) === route) routes.delete(path)
        return closePeers(route.peers, options.closeTimeoutMs)
      }
    }, `websocket.route(${path})`)
  }

  address(): AddressInfo | null {
    const address = this.state.listener?.server.address()
    return address && typeof address !== 'string' ? address : null
  }

  [createIngress](timeoutMs: number | null = this.options.closeTimeoutMs): Ingress {
    const accepted = new Set<Peer>()
    let closing: Promise<void> | undefined
    return {
      handleUpgrade: (upgrade) => {
        const { request } = upgrade
        if (closing || this.state.stopped || request.headers.upgrade?.toLowerCase() !== 'websocket') return false
        const path = request.url?.match(/^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)(?:\?[^#]*)?$/i)?.[1]
        const route = path && this.routes.get(path)
        if (!route) return false
        const engine = route.endpoint[namedEndpoint] ? this.getNamedEngine() : this.engine
        const peer = openPeer(engine, upgrade, route.endpoint, this.options, this.reportError)
        route.peers.add(peer)
        this.peers.add(peer)
        accepted.add(peer)
        void peer.closed.then(() => {
          route.peers.delete(peer)
          this.peers.delete(peer)
          accepted.delete(peer)
        })
        return true
      },
      close() {
        return closing ??= closePeers(accepted, timeoutMs)
      },
    }
  }

  private getNamedEngine(): WebSocketServer {
    return this.namedEngine ??= new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: 0,
      maxBufferedChunks: 0,
      maxFragments: 0,
    })
  }

  async [startListener](ctx: Context, options: WebSocketListenerOptions): Promise<() => Promise<void>> {
    const { state } = this
    if (state.listener) throw new Error('The WebSocket service already has a standalone listener')

    const listener = createListener(options, this[createIngress](null), this.reportError)
    state.listener = listener
    const close = () => listener.close().finally(() => {
      if (state.listener === listener) state.listener = undefined
    })
    const startup = new AbortController()
    const stopWatchingDisposal = ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) startup.abort()
    })
    const stopWatchingService = ctx.on('internal/service', (name) => {
      if (name === 'websocket' && ctx.get('websocket')?.state !== state) startup.abort()
    })

    try {
      await listener.open(startup.signal)
      if (startup.signal.aborted) await close()
    } catch (error) {
      await close().catch(this.reportError)
      if (!startup.signal.aborted) throw error
    } finally {
      stopWatchingDisposal()
      stopWatchingService()
    }
    return close
  }
}

export type WebSocketService = Pick<Websocket, 'route' | 'address'>

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly websocket: Websocket
  }
}

export const websocketListener = {
  name: 'websocket-listener',
  inject: ['websocket'],
  async apply(ctx: Context, options: WebSocketListenerOptions): Promise<void> {
    await ctx.effect(() => ctx.websocket[startListener](ctx, options), 'websocket.listen()')
  },
}
