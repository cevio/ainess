import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { refuseUpgrade } from './connection.js'
import { integerOption } from './options.js'
import type { Upgrade, WebSocketListenerOptions } from './types.js'

export interface Ingress {
  handleUpgrade(upgrade: Upgrade): boolean
  close(): Promise<void>
}

export function createListener(
  options: WebSocketListenerOptions,
  ingress: Ingress,
  reportError: (error: unknown) => void,
) {
  const { host } = options
  const port = integerOption('port', options.port, 0, 65_535)
  const shutdownTimeoutMs = integerOption('shutdownTimeoutMs', options.shutdownTimeoutMs ?? 30_000, 0)
  const sockets = new Set<Socket>()
  const server = createServer((_request, response) => response.writeHead(404).end())
  let closing: Promise<void> | undefined

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', reportError)
    if (closing) return refuseUpgrade(socket, 503)
    if (!ingress.handleUpgrade({ request, socket, head })) refuseUpgrade(socket, 404)
  })

  async function drain() {
    const stopped = new Promise<NodeJS.ErrnoException | undefined>((resolve) => server.close(resolve))
    const timeout = setTimeout(() => {
      for (const socket of sockets) socket.destroy()
    }, shutdownTimeoutMs).unref()
    try {
      const [error] = await Promise.all([stopped, ingress.close()])
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    server,
    async open(signal: AbortSignal) {
      server.listen({ host, port, signal })
      await once(server, 'listening', { signal })
      server.on('error', reportError)
    },
    close() {
      return closing ??= drain()
    },
  }
}
