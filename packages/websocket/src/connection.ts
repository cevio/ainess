import { addAbortListener } from 'node:events'
import { STATUS_CODES } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { type WebSocketServer } from 'ws'
import { namedEndpoint, type TransportRoute } from './route.js'
import type { Upgrade, WebSocketConnection, WebSocketMessage, WebSocketOptions, WebSocketRouteOptions } from './types.js'

export interface Peer {
  readonly closed: Promise<void>
  close(): void
  terminate(): void
  heartbeat(): void
}

type ReportError = (error: unknown) => void
const maxQueuedMessages = 256

export function refuseUpgrade(socket: Duplex, status: number) {
  if (!socket.writable || socket.writableEnded) return
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => {
    socket.destroy()
  })
}

export async function closePeers(peers: ReadonlySet<Peer>, timeoutMs: number | null) {
  if (!peers.size) return
  const active = [...peers]
  for (const peer of active) peer.close()
  const timer = timeoutMs === null ? undefined : setTimeout(() => {
    for (const peer of active) peer.terminate()
  }, timeoutMs).unref()
  try {
    await Promise.all(active.map((peer) => peer.closed))
  } finally {
    clearTimeout(timer)
  }
}

function sendMessage(ws: WebSocket, message: WebSocketMessage, limit: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is closed')
    if (typeof message !== 'string' && !(message instanceof Uint8Array)) {
      throw new TypeError('WebSocket messages must be strings or Uint8Array values')
    }
    if (limit !== undefined) {
      const size = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength
      const header = size < 126 ? 2 : size < 65_536 ? 4 : 10
      if (ws.bufferedAmount + size + header > limit) throw new Error('WebSocket send buffer limit exceeded')
    }
    ws.send(message, (error) => error ? reject(error) : resolve())
  })
}

function dispatchMessages(
  ws: WebSocket,
  connection: WebSocketConnection<unknown>,
  route: WebSocketRouteOptions<unknown>,
  limit: number,
  reportError: ReportError,
) {
  const queue: { data: Buffer, binary: boolean }[] = []
  let queuedBytes = 0
  let opened = false
  let processing = false
  const { signal } = connection
  signal.addEventListener('abort', () => {
    queue.length = 0
    queuedBytes = 0
  }, { once: true })

  async function dispatch() {
    if (!opened) {
      opened = true
      if (!signal.aborted) await route.onOpen?.(connection)
    }
    while (queue.length && !signal.aborted) {
      const { data, binary } = queue.shift()!
      queuedBytes -= data.byteLength
      await route.onMessage?.(connection, binary ? data : data.toString())
    }
  }

  function schedule() {
    if (processing || signal.aborted) return
    processing = true
    void dispatch().catch((error) => {
      if (signal.aborted) return
      reportError(error)
      connection.close(1011)
    }).finally(() => {
      processing = false
      if (queue.length) schedule()
    })
  }

  if (route.onMessage) {
    ws.on('message', (raw, binary) => {
      if (signal.aborted) return
      // ws emits nodebuffer data with its default binaryType.
      const data = raw as Buffer
      if (queue.length >= maxQueuedMessages || queuedBytes + data.byteLength > limit) {
        connection.close(1013)
        return
      }
      queue.push({ data, binary })
      queuedBytes += data.byteLength
      schedule()
    })
  }
  schedule()
}

function dispatchNamedMessages(
  ws: WebSocket,
  connection: WebSocketConnection<unknown>,
  route: TransportRoute<unknown>,
  reportError: ReportError,
) {
  function failed(error: unknown) {
    if (connection.signal.aborted) return
    reportError(error)
    connection.close(1011)
  }
  ws.on('message', (raw, binary) => {
    if (connection.signal.aborted) return
    const data = raw as Buffer
    try {
      void route.onMessage?.(connection, binary ? data : data.toString())?.catch(failed)
    } catch (error) {
      failed(error)
    }
  })
  // Named endpoints register their per-connection dispatcher synchronously.
  void route.onOpen?.(connection)?.catch(failed)
}

export function openPeer(
  server: WebSocketServer,
  upgrade: Upgrade,
  route: TransportRoute<unknown>,
  options: Required<WebSocketOptions>,
  reportError: ReportError,
): Peer {
  const { request, socket, head } = upgrade
  const lifetime = new AbortController()
  const { signal } = lifetime
  let finish!: () => void
  const closed = new Promise<void>((resolve) => { finish = resolve })
  let connection: WebSocket | undefined
  let closeTimer: NodeJS.Timeout | undefined
  let receivedPong = true
  const handshakeTimer = setTimeout(() => refuse(408), options.handshakeTimeoutMs).unref()

  function endWork() {
    clearTimeout(handshakeTimer)
    lifetime.abort()
  }

  function refuse(status: number) {
    if (signal.aborted) return
    endWork()
    refuseUpgrade(socket, status)
  }

  function retire() {
    if (!connection) return refuse(503)
    connection.close(1001)
    endWork()
  }

  function endPendingHandshake() {
    // Before ws owns the socket, a peer's FIN can leave the writable half open indefinitely.
    if (!signal.aborted) socket.destroy()
  }

  const shutdown = upgrade.signal && addAbortListener(upgrade.signal, retire)
  socket.on('error', () => socket.destroy())
  socket.once('end', endPendingHandshake)
  socket.once('close', () => {
    socket.off('end', endPendingHandshake)
    shutdown?.[Symbol.dispose]()
    clearTimeout(closeTimer)
    endWork()
    if (!connection) finish()
  })

  function accept(ws: WebSocket, state: unknown) {
    socket.off('end', endPendingHandshake)
    connection = ws
    clearTimeout(handshakeTimer)
    const named = route[namedEndpoint] === true
    const peer: WebSocketConnection<unknown> = {
      state,
      signal,
      send: (message) => sendMessage(ws, message, named ? undefined : options.maxBufferedBytes),
      close(code = 1000, reason) {
        ws.close(code, reason)
        endWork()
        if (!closeTimer && ws.readyState !== WebSocket.CLOSED) {
          closeTimer = setTimeout(() => ws.terminate(), options.closeTimeoutMs).unref()
        }
      },
    }
    ws.on('error', (error) => {
      if (!signal.aborted) reportError(error)
      endWork()
    })
    ws.on('pong', () => { receivedPong = true })
    ws.once('close', (code, reason) => {
      endWork()
      finish()
      void (async () => route.onClose?.(peer, { code, reason: reason.toString() }))().catch(reportError)
    })
    if (named) dispatchNamedMessages(ws, peer, route, reportError)
    else dispatchMessages(ws, peer, route, options.maxBufferedBytes, reportError)
  }

  void Promise.resolve().then(async () => {
    if (signal.aborted || socket.destroyed || socket.writableEnded) return
    let state: unknown
    if (route.authorize) {
      const result = await route.authorize({ request, signal })
      if (signal.aborted || socket.destroyed || socket.writableEnded) return
      if (result.accept === false) {
        if (![400, 401, 403, 429].includes(result.status)) throw new TypeError('Invalid WebSocket rejection status')
        refuse(result.status)
        return
      }
      if (result.accept !== true) throw new TypeError('Invalid WebSocket authorization result')
      state = result.state
    }
    server.handleUpgrade(request, socket, head, (ws) => accept(ws, state))
  }).catch((error) => {
    if (signal.aborted) return
    reportError(error)
    if (connection) connection.terminate()
    else refuse(500)
  })

  return {
    closed,
    close: retire,
    terminate: () => socket.destroy(),
    heartbeat() {
      if (connection?.readyState !== WebSocket.OPEN) return
      if (!receivedPong) return connection.terminate()
      receivedPong = false
      connection.ping()
    },
  }
}
