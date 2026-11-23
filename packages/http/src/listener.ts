import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { requestSignalStorage } from './request-signal-storage.js'

export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

export interface PreparedHttp {
  handle: HttpHandler
  /** Used by the HTTP handler after an unanswered route miss. */
  onRouteMiss?: HttpHandler
  dispose?: () => void | Promise<void>
}

export type HttpPrepare = (server: Server, handleHttp: HttpHandler) => PreparedHttp | Promise<PreparedHttp>

export interface HttpListenerOptions {
  port: number
  host?: string
  shutdownTimeoutMs?: number
  prepare?: HttpPrepare
}

export function createListener(options: HttpListenerOptions, reportError: (error: unknown) => void) {
  const { port, host, prepare, shutdownTimeoutMs = 30_000 } = options
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 0 || shutdownTimeoutMs > 2_147_483_647) {
    throw new RangeError('shutdownTimeoutMs must be an integer from 0 to 2147483647')
  }

  const server = createServer()
  const sockets = new Set<Socket>()
  let activeResponses = 0
  let notifyDrained: (() => void) | undefined
  let draining = false
  let prepared: PreparedHttp | undefined
  let closing: Promise<void> | undefined

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  async function open(handleHttp: HttpHandler, signal: AbortSignal) {
    prepared = await prepare?.(server, handleHttp)
    if (signal.aborted) return

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
      if (activeResponses) {
        await new Promise<void>((resolve) => { notifyDrained = resolve })
      }
      // Close remaining connections, including upgrades, after pending writes have flushed.
      for (const socket of sockets) socket.destroySoon()
      const error = await closed
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') throw error
    } finally {
      clearTimeout(deadline)
    }
  }

  return {
    server,
    open,
    get onRouteMiss() {
      return prepared?.onRouteMiss
    },
    close() {
      return closing ??= drain().finally(() => prepared?.dispose?.())
    },
  }
}
