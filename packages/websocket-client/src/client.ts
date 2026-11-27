export type WebSocketClientMessage = string | Uint8Array

export interface WebSocketClientCloseInfo {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

export interface WebSocketClient {
  readonly readyState: number
  send(message: WebSocketClientMessage): void
  close(code?: number, reason?: string): void
}

export interface WebSocketClientOptions {
  protocols?: string | readonly string[]
  signal?: AbortSignal
  connectTimeoutMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
  shouldReconnect?(close: WebSocketClientCloseInfo): boolean
  onOpen?(client: WebSocketClient): void | Promise<void>
  onMessage?(message: WebSocketClientMessage, client: WebSocketClient): void | Promise<void>
  onClose?(close: WebSocketClientCloseInfo, client: WebSocketClient): void | Promise<void>
  onError?(error: unknown, client: WebSocketClient): void | Promise<void>
}

const terminalCloseCodes = new Set([1000, 1002, 1003, 1007, 1008, 1009, 1010])

function integerOption(name: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer from ${min} to 2147483647`)
  }
  return value
}

export function connectWebSocket(url: string | URL, options?: WebSocketClientOptions): WebSocketClient {
  return connectWebSocketTransport(url, options)
}

export function connectWebSocketTransport(
  url: string | URL,
  options: WebSocketClientOptions = {},
  onAbort?: () => void,
): WebSocketClient {
  const { signal, shouldReconnect, onOpen, onMessage, onClose, onError } = options
  signal?.throwIfAborted()
  const address = String(url)
  const offeredProtocols = options.protocols
  const protocols = typeof offeredProtocols === 'string' ? offeredProtocols : offeredProtocols?.slice()
  const connectTimeout = integerOption('connectTimeoutMs', options.connectTimeoutMs ?? 10_000, 1)
  const initialDelay = integerOption('initialDelayMs', options.initialDelayMs ?? 500, 1)
  const maxDelay = integerOption('maxDelayMs', options.maxDelayMs ?? 10_000, initialDelay)
  const maxAttempts = options.maxAttempts
  const limit = maxAttempts === undefined || maxAttempts === Infinity
    ? Infinity : integerOption('maxAttempts', maxAttempts, 0)

  let socket: WebSocket | undefined
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let stopped = false

  const client: WebSocketClient = {
    get readyState() {
      return socket?.readyState ?? (stopped ? WebSocket.CLOSED : WebSocket.CONNECTING)
    },
    send(message) {
      if (stopped || socket?.readyState !== WebSocket.OPEN) throw new Error('WebSocket client is not open')
      if (typeof message === 'string') return socket.send(message)
      const { buffer, byteOffset, byteLength } = message
      const bytes = buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer, byteOffset, byteLength) : new Uint8Array(message)
      socket.send(bytes)
    },
    close(code = 1000, reason) {
      if (stopped) return
      const current = socket
      const connecting = current?.readyState === WebSocket.CONNECTING
      current?.close(code, reason)
      stop()
      if (connecting) settleHandshakeFailure(current)
    },
  }

  const abort = () => {
    client.close()
    onAbort?.()
  }

  function stop() {
    stopped = true
    clearTimeout(connectTimer)
    clearTimeout(retryTimer)
    signal?.removeEventListener('abort', abort)
  }

  async function report(error: unknown) {
    try {
      await onError?.(error, client)
    } catch {
      // An error observer cannot change the state of the connection.
    }
  }

  async function notify(callback: () => void | Promise<void>) {
    try {
      await callback()
    } catch (error) {
      await report(error)
    }
  }

  function scheduleRetry(close: WebSocketClientCloseInfo) {
    if (stopped) return
    if (attempts >= limit) return stop()
    const eligible = shouldReconnect ? shouldReconnect(close) : !terminalCloseCodes.has(close.code)
    if (stopped || !eligible) return stop()

    const ceiling = Math.min(maxDelay, initialDelay * 2 ** Math.min(attempts++, 31))
    const delay = Math.max(1, Math.floor(ceiling * (0.5 + Math.random() * 0.5)))
    retryTimer = setTimeout(() => {
      try {
        open()
      } catch (error) {
        stop()
        void report(error)
      }
    }, delay)
  }

  function finish(current: WebSocket, close: WebSocketClientCloseInfo) {
    if (socket !== current) return
    clearTimeout(connectTimer)
    socket = undefined
    try {
      scheduleRetry(close)
    } catch (error) {
      stop()
      void report(error)
    }
    if (onClose) void notify(() => onClose(close, client))
  }

  function settleHandshakeFailure(current: WebSocket) {
    // Older native implementations sometimes emit only error during the handshake.
    queueMicrotask(() => {
      if (socket !== current || current.readyState === WebSocket.OPEN) return
      if (current.readyState === WebSocket.CONNECTING) current.close()
      finish(current, { code: 1006, reason: '', wasClean: false })
    })
  }

  function open() {
    signal?.throwIfAborted()
    const current = socket = new WebSocket(address, protocols)
    current.binaryType = 'arraybuffer'
    connectTimer = setTimeout(() => settleHandshakeFailure(current), connectTimeout)
    let opened = false

    current.addEventListener('open', () => {
      if (socket !== current || stopped) return
      clearTimeout(connectTimer)
      opened = true
      attempts = 0
      if (onOpen) void notify(() => onOpen(client))
    }, { once: true })
    if (onMessage) {
      current.addEventListener('message', ({ data }) => {
        if (socket !== current || stopped) return
        const message = typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer)
        void notify(() => onMessage(message, client))
      })
    }
    current.addEventListener('error', (event) => {
      if (socket !== current) return
      if (!stopped) void report(event)
      if (!opened) settleHandshakeFailure(current)
    }, { once: true })
    current.addEventListener('close', ({ code, reason, wasClean }) => {
      finish(current, { code, reason, wasClean })
    }, { once: true })
  }

  open()
  signal?.addEventListener('abort', abort, { once: true })
  return client
}
