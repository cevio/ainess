import { once } from 'node:events'
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { isPromise } from 'node:util/types'
import { requestSignalStorage } from './request-signal-storage.js'

export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

export interface HttpUpgrade {
  readonly request: IncomingMessage
  readonly socket: Duplex
  readonly head: Buffer
  /** Aborted when the listener starts draining. */
  readonly signal: AbortSignal
}

/** Return true synchronously to take ownership of the socket, or false to pass it on. */
export type HttpUpgradeHandler = (upgrade: HttpUpgrade) => boolean

export interface PreparedHttp {
  handle: HttpHandler
  /** Used by the HTTP handler after an unanswered route miss. */
  onRouteMiss?: HttpHandler
  /** Fallback after registered upgrade handlers decline the request. */
  onUpgrade?: HttpUpgradeHandler
  dispose?: () => void | Promise<void>
}

export type HttpPrepare = (server: Server, handleHttp: HttpHandler) => PreparedHttp | Promise<PreparedHttp>

export interface HttpListenerOptions {
  port: number
  host?: string
  shutdownTimeoutMs?: number
  prepare?: HttpPrepare
}

export function createListener(
  options: HttpListenerOptions,
  reportError: (error: unknown) => void,
  upgrades: ReadonlyMap<symbol, HttpUpgradeHandler>,
) {
  const { port, host, prepare, shutdownTimeoutMs = 30_000 } = options
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0 || shutdownTimeoutMs > 2_147_483_647) {
    throw new RangeError('shutdownTimeoutMs must be an integer from 0 to 2147483647')
  }

  const server = createServer()
  const sockets = new Set<Socket>()
  const upgraded = new Set<Duplex>()
  const shutdown = new AbortController()
  let activeResponses = 0
  let notifyDrained: (() => void) | undefined
  let draining = false
  let ready = false
  let upgradeListening = false
  let prepared: PreparedHttp | undefined
  let closing: Promise<void> | undefined

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      upgraded.delete(socket)
    })
  })

  function rejectUpgrade(socket: Duplex, status: 404 | 503) {
    socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => {
      socket.destroy()
    })
  }

  function claimedUpgrade(result: unknown): boolean {
    if (typeof result === 'boolean') return result
    if (isPromise(result)) void result.catch(() => {})
    throw new TypeError('HTTP upgrade handlers must return true or false synchronously')
  }

  function dispatchUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', reportError)
    if (draining) return rejectUpgrade(socket, 503)

    const upgrade = { request, socket, head, signal: shutdown.signal }
    upgraded.add(socket)
    try {
      for (const id of [...upgrades.keys()]) {
        const handle = upgrades.get(id)
        if (handle && claimedUpgrade(handle(upgrade))) return
      }
      upgraded.delete(socket)
      const fallback = prepared?.onUpgrade
      if (fallback && claimedUpgrade(fallback.call(prepared, upgrade))) return
      rejectUpgrade(socket, 404)
    } catch (error) {
      reportError(error)
      socket.destroy()
    }
  }

  server.on('newListener', (event, listener) => {
    if (event !== 'upgrade') return
    const conflict = listener === dispatchUpgrade ? server.listenerCount('upgrade') > 0 : upgradeListening
    if (conflict) {
      throw new Error('Managed HTTP upgrades require exclusive dispatch')
    }
  })

  function refreshUpgrade() {
    if (!ready || draining) return
    const enabled = upgrades.size > 0 || Boolean(prepared?.onUpgrade)
    if (enabled === upgradeListening) return
    if (!enabled) {
      upgradeListening = false
      server.off('upgrade', dispatchUpgrade)
      return
    }
    // Registering an EventEmitter listener synchronously invokes user hooks.
    upgradeListening = true
    try {
      server.on('upgrade', dispatchUpgrade)
    } catch (error) {
      upgradeListening = false
      throw error
    }
  }

  async function open(handleHttp: HttpHandler, signal: AbortSignal) {
    prepared = await prepare?.(server, handleHttp)
    if (signal.aborted) return
    ready = true
    refreshUpgrade()

    const handle = prepared?.handle ?? handleHttp
    server.on('request', async (request, response) => {
      if (draining) {
        response.writeHead(503, { connection: 'close' }).end()
        return
      }

      const cancellation = new AbortController()
      activeResponses++
      const done = () => {
        response.off('finish', done)
        response.off('close', done)
        if (--activeResponses === 0) notifyDrained?.()
        if (!response.writableFinished) cancellation.abort()
      }
      response.once('finish', done)
      response.once('close', done)
      try {
        await requestSignalStorage.run(cancellation.signal, () => handle(request, response))
      } catch (error) {
        reportError(error)
        if (response.writableEnded || response.destroyed) return
        if (response.headersSent) {
          response.destroy()
          return
        }
        for (const name of response.getHeaderNames()) response.removeHeader(name)
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Internal Server Error')
      }
    })

    server.listen({ port, host, signal })
    await once(server, 'listening', { signal })
    server.on('error', reportError)
  }

  async function drain() {
    draining = true
    const closed = new Promise<NodeJS.ErrnoException | undefined>((resolve) => server.close(resolve))
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy()
    }, shutdownTimeoutMs)

    try {
      shutdown.abort()
      if (activeResponses) {
        await new Promise<void>((resolve) => { notifyDrained = resolve })
      }
      for (const socket of sockets) {
        if (!upgraded.has(socket)) socket.destroySoon()
      }
      const error = await closed
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') throw error
    } finally {
      clearTimeout(deadline)
    }
  }

  return {
    server,
    open,
    refreshUpgrade,
    get onRouteMiss() {
      return prepared?.onRouteMiss
    },
    close() {
      return closing ??= drain().finally(() => prepared?.dispose?.())
    },
  }
}
