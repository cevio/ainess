import {
  decodeWebSocketFrame,
  encodeWebSocketFrame,
  pumpWebSocketStream,
  WebSocketEndpointError,
  WebSocketMethodMode,
  WebSocketStreamQueue,
  type WebSocketFrame,
} from '@ainess/websocket-shared'
import { connectWebSocketTransport, type WebSocketClientCloseInfo, type WebSocketClientOptions } from './client.js'

export interface WebSocketCallOptions<Input = unknown> {
  input?: (signal: AbortSignal) => AsyncIterable<Input>
  signal?: AbortSignal
  timeoutMs?: number
}

type EventListener<Data> = (data: Data) => void | Promise<void>

export interface WebSocketEndpointClient {
  readonly readyState: number
  call<Output = unknown, Input = unknown>(
    name: string, data?: unknown, options?: WebSocketCallOptions<Input>,
  ): Promise<Output>
  stream<Output = unknown, Input = unknown>(
    name: string, data?: unknown, options?: WebSocketCallOptions<Input>,
  ): AsyncIterableIterator<Output>
  emit(name: string, data?: unknown): void
  on<Data = unknown>(name: string, listener: EventListener<Data>): () => void
  close(code?: number, reason?: string): void
}

export interface WebSocketEndpointClientOptions extends Omit<
  WebSocketClientOptions, 'onOpen' | 'onMessage' | 'onClose' | 'onError'
> {
  onOpen?(client: WebSocketEndpointClient): void | Promise<void>
  onClose?(close: WebSocketClientCloseInfo, client: WebSocketEndpointClient): void | Promise<void>
  onError?(error: unknown, client: WebSocketEndpointClient): void | Promise<void>
}

interface CallOutput {
  readonly chunk?: (data: unknown) => void
  readonly remoteError?: (error: WebSocketEndpointError) => void
  complete(data: unknown): void
  fail(error: unknown): void
}

interface PendingCall extends CallOutput {
  readonly id: string
  cleanup(): void
}

function checkName(name: string): void {
  if (typeof name !== 'string' || !name.length) throw new TypeError('A WebSocket method or event name is required')
}

export function connectWebSocketEndpoint(
  url: string | URL,
  options: WebSocketEndpointClientOptions = {},
): WebSocketEndpointClient {
  const { onOpen, onClose, onError, ...transportOptions } = options
  const calls = new Map<string, PendingCall>()
  const events = new Map<string, Set<EventListener<unknown>>>()
  let nextId = 0n

  const client: WebSocketEndpointClient = {
    get readyState() { return transport.readyState },
    call<Output>(name: string, data?: unknown, options?: WebSocketCallOptions) {
      return new Promise<Output>((resolve, reject) => {
        open(name, data, options, { complete: (value) => resolve(value as Output), fail: reject })
      })
    },
    stream<Output>(name: string, data?: unknown, options?: WebSocketCallOptions) {
      const queue = new WebSocketStreamQueue<Output>()
      let call: PendingCall | undefined
      try {
        call = open(name, data, options, {
          chunk: (value) => queue.push(value as Output),
          remoteError: (error) => queue.fail(error, { drain: true }),
          complete: () => queue.end(),
          fail: (error) => queue.fail(error),
        })
      } catch (error) {
        queue.fail(error)
      }
      return {
        [Symbol.asyncIterator]() { return this },
        next: () => queue.next(),
        async return(): Promise<IteratorResult<Output>> {
          if (call && retire(call)) cancel(call.id)
          queue.discard()
          return { value: undefined, done: true }
        },
      }
    },
    emit(name, data) {
      checkName(name)
      send({ type: 'event', name, data })
    },
    on<Data>(name: string, listener: EventListener<Data>) {
      checkName(name)
      if (typeof listener !== 'function') throw new TypeError('WebSocket event listener must be a function')
      const listeners = events.get(name) ?? new Set<EventListener<unknown>>()
      const handle: EventListener<unknown> = (data) => listener(data as Data)
      events.set(name, listeners)
      listeners.add(handle)
      return () => {
        if (listeners.delete(handle) && !listeners.size) events.delete(name)
      }
    },
    close(code, reason) {
      transport.close(code, reason)
      disconnect()
    },
  }

  function assertOpen() {
    if (transport.readyState !== WebSocket.OPEN) throw new WebSocketEndpointError('NOT_OPEN', 'WebSocket is not open')
  }

  function send(frame: WebSocketFrame) {
    assertOpen()
    transport.send(encodeWebSocketFrame(frame))
  }

  function cancel(id: string) {
    try {
      send({ type: 'cancel', id })
    } catch {
      // The disconnected transport releases the peer's invocation.
    }
  }

  function retire(call: PendingCall): boolean {
    if (calls.get(call.id) !== call) return false
    calls.delete(call.id)
    call.cleanup()
    return true
  }

  function fail(call: PendingCall, error: unknown, notify: boolean) {
    if (!retire(call)) return
    if (notify) cancel(call.id)
    call.fail(error)
  }

  function disconnect(error = new WebSocketEndpointError('DISCONNECTED')) {
    const pending = [...calls.values()]
    calls.clear()
    for (const call of pending) {
      call.cleanup()
      call.fail(error)
    }
  }

  function open(
    name: string,
    data: unknown,
    options: WebSocketCallOptions | undefined,
    output: CallOutput,
  ): PendingCall {
    const { input, signal, timeoutMs } = options ?? {}
    checkName(name)
    if (input !== undefined && typeof input !== 'function') {
      throw new TypeError('WebSocket call input must be a function')
    }
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)) {
      throw new RangeError('WebSocket call timeoutMs must be an integer from 1 to 2147483647')
    }
    const cancellation = () => new WebSocketEndpointError('CANCELLED', undefined, { cause: signal?.reason })
    if (signal?.aborted) throw cancellation()
    assertOpen()

    const mode = (input ? WebSocketMethodMode.ClientStream : 0)
      | (output.chunk ? WebSocketMethodMode.ServerStream : 0)
    let id!: string
    const message = encodeWebSocketFrame({
      type: 'call', name, mode, data,
      get id() {
        // JSON serializes the payload before allocating the ID. A toJSON hook can start another call.
        return id = String(++nextId)
      },
    })
    if (signal?.aborted) throw cancellation()
    assertOpen()
    const controller = new AbortController()
    const abort = () => fail(call, cancellation(), true)
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      fail(call, new WebSocketEndpointError('DEADLINE_EXCEEDED'), true)
    }, timeoutMs)
    const call: PendingCall = {
      ...output, id,
      cleanup() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        controller.abort()
      },
    }
    calls.set(id, call)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      transport.send(message)
    } catch (error) {
      fail(call, error, false)
    }
    if (input && !controller.signal.aborted) {
      void Promise.resolve().then(async () => {
        const source = controller.signal
        source.throwIfAborted()
        await pumpWebSocketStream(input(source), source, (chunk) => send({ type: 'chunk', id, data: chunk }))
        if (!source.aborted) send({ type: 'input-end', id })
      }).catch((error) => fail(call, error, true))
    }
    return call
  }

  async function report(error: unknown) {
    try {
      await onError?.(error, client)
    } catch {
      // Observers do not own the transport or pending invocations.
    }
  }

  function receive(message: string | Uint8Array) {
    try {
      const frame = decodeWebSocketFrame(message)
      if (frame.type === 'event') {
        for (const listener of events.get(frame.name) ?? []) {
          void Promise.resolve().then(() => listener(frame.data)).catch(report)
        }
        return
      }
      if (frame.type === 'call' || frame.type === 'input-end' || frame.type === 'cancel') {
        throw new WebSocketEndpointError('PROTOCOL_ERROR', 'Unexpected frame from server')
      }
      const call = calls.get(frame.id)
      if (!call) return
      if (frame.type === 'error') {
        if (retire(call)) {
          const error = new WebSocketEndpointError(frame.error.code, frame.error.message)
          const fail = call.remoteError ?? call.fail
          fail(error)
        }
      } else if (frame.type === 'chunk' && call.chunk) {
        call.chunk(frame.data)
      } else if (frame.type === 'end' && call.chunk) {
        if (retire(call)) call.complete(undefined)
      } else if (frame.type === 'result' && !call.chunk) {
        if (retire(call)) call.complete(frame.data)
      } else {
        throw new WebSocketEndpointError('PROTOCOL_ERROR', 'Response does not match the call mode')
      }
    } catch (cause) {
      const error = new WebSocketEndpointError('PROTOCOL_ERROR', 'Invalid WebSocket response', { cause })
      // Cancelling uploads can run application code that starts another call.
      transport.close(3002, 'Invalid protocol frame')
      disconnect(error)
      void report(error)
    }
  }

  const transport = connectWebSocketTransport(url, {
    ...transportOptions,
    onOpen() {
      nextId = 0n
      return onOpen?.(client)
    },
    onMessage: receive,
    onClose(info) {
      disconnect()
      return onClose?.(info, client)
    },
    onError: report,
  }, disconnect)
  return client
}
