import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { observeAbort } from './abort.js'
import { IncomingCalls } from './incoming.js'
import { MethodRegistry } from './methods.js'
import { MessageModem, resolveCallLimit } from './modem.js'
import { OutgoingCalls } from './outgoing.js'
import { RpcError } from './types.js'
import type { Bytes, RpcAddress, RpcCallOptions, RpcCloseInfo, RpcCloseReason, RpcMethod } from './types.js'
import { LIMITS } from './wire.js'

export interface RpcPeerOptions {
  signal?: AbortSignal
  methods?: readonly RpcMethod[]
  maxConcurrentCalls?: number
}

function cancelled(): RpcError {
  return new RpcError('CANCELLED', 'RPC connection cancelled')
}

export class RpcPeer {
  #modem: MessageModem
  #incoming: IncomingCalls
  #outgoing: OutgoingCalls
  #closeInfo: RpcCloseInfo | undefined
  #closeListeners: Set<(info: RpcCloseInfo) => void> | undefined

  private constructor(
    socket: Socket,
    role: 'dialer' | 'acceptor',
    private readonly methods: MethodRegistry,
    maxCalls: number,
    sharedMethods?: MethodRegistry,
    onPeer?: (peer: RpcPeer) => void,
    onClose?: () => void,
  ) {
    this.#modem = new MessageModem(socket, role, (frame, release) => {
      const calls = this.#modem.isLocal(frame.id) ? this.#outgoing : this.#incoming
      calls.receive(frame, release)
    }, (error, reason) => {
      this.methods.clear()
      this.#outgoing.closed(error)
      this.#incoming.closed(error)
      onClose?.()
      this.#notifyClose(error, reason)
    }, onPeer && (() => this.#notify(onPeer)), maxCalls)
    this.#incoming = new IncomingCalls(this.#modem, this, methods, sharedMethods)
    this.#outgoing = new OutgoingCalls(this.#modem)
  }

  static async connect(address: RpcAddress, options?: RpcPeerOptions): Promise<RpcPeer> {
    const signal = options?.signal
    if (signal?.aborted) throw cancelled()
    const maxCalls = resolveCallLimit(options?.maxConcurrentCalls)
    const methods = new MethodRegistry()
    for (const method of options?.methods ?? []) methods.register(method)

    const socketOptions = { host: address.host, port: address.port, highWaterMark: LIMITS.callWindow }
    const socket = createConnection(socketOptions)
    const peer = new RpcPeer(socket, 'dialer', methods, maxCalls)
    let disposeAbort: (() => void) | undefined
    try {
      if (signal) disposeAbort = observeAbort(signal, () => {
        void peer.#modem.close(cancelled(), 'local')
      })
      await peer.#modem.ready
      if (signal?.aborted) throw cancelled()
      if (peer.#modem.failure) throw peer.#modem.failure
      return peer
    } catch (error) {
      await peer.close()
      throw error
    } finally {
      disposeAbort?.()
    }
  }

  /** @internal */
  static accept(
    socket: Socket,
    sharedMethods: MethodRegistry,
    maxCalls: number,
    onPeer: ((peer: RpcPeer) => void) | undefined,
    onClose: () => void,
  ): RpcPeer {
    return new RpcPeer(socket, 'acceptor', new MethodRegistry(), maxCalls, sharedMethods, onPeer, onClose)
  }

  register(method: RpcMethod): () => Promise<void> {
    if (this.#modem.failure) throw this.#modem.failure
    return this.methods.register(method)
  }

  request(name: string, options?: RpcCallOptions): Promise<Bytes>
  request(name: string, data: Bytes | undefined, options?: RpcCallOptions): Promise<Bytes>
  request(name: string, dataOrOptions?: Bytes | RpcCallOptions, options?: RpcCallOptions): Promise<Bytes> {
    return this.#outgoing.request(name, dataOrOptions, options)
  }

  stream(name: string, options?: RpcCallOptions): AsyncIterableIterator<Bytes>
  stream(name: string, data: Bytes | undefined, options?: RpcCallOptions): AsyncIterableIterator<Bytes>
  stream(name: string, dataOrOptions?: Bytes | RpcCallOptions, options?: RpcCallOptions): AsyncIterableIterator<Bytes> {
    return this.#outgoing.stream(name, dataOrOptions, options)
  }

  onClose(listener: (info: RpcCloseInfo) => void): () => void {
    const closed = this.#closeInfo
    let listeners = closed ? undefined : (this.#closeListeners ??= new Set())
    let subscribed: typeof listener | undefined = listener
    const notify = (info: RpcCloseInfo) => {
      listeners = undefined
      void Promise.resolve().then(() => {
        const callback = subscribed
        subscribed = undefined
        return callback?.(info)
      }).catch(() => {})
    }
    listeners?.add(notify)
    if (closed) notify(closed)

    return () => {
      subscribed = undefined
      listeners?.delete(notify)
      listeners = undefined
    }
  }

  close(): Promise<void> {
    return this.#modem.close()
  }

  #notifyClose(error: RpcError, reason: RpcCloseReason): void {
    const info = Object.freeze({ error, reason })
    this.#closeInfo = info
    const listeners = this.#closeListeners
    this.#closeListeners = undefined
    if (!listeners) return
    for (const notify of listeners) notify(info)
  }

  #notify(onPeer: (peer: RpcPeer) => void): void {
    const failed = (cause: unknown) => {
      void this.#modem.close(new RpcError('UNAVAILABLE', 'RPC peer callback failed', { cause }))
    }
    try {
      void Promise.resolve(onPeer(this)).catch(failed)
    } catch (cause) {
      failed(cause)
    }
  }
}
