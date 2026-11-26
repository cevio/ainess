import { once } from 'node:events'
import { createServer } from 'node:net'
import { observeAbort } from './abort.js'
import { deferred } from './deferred.js'
import { MethodRegistry } from './methods.js'
import { resolveKeepAliveInitialDelay } from './modem.js'
import { RpcPeer } from './peer.js'
import { RpcError } from './types.js'
import type { RpcAddress, RpcMethod } from './types.js'
import { LIMITS } from './wire.js'

export interface RpcServerOptions extends RpcAddress {
  methods?: readonly RpcMethod[]
  onPeer?: (peer: RpcPeer) => void
  keepAliveInitialDelayMs?: number
  signal?: AbortSignal
}

function cancelled(): RpcError {
  return new RpcError('CANCELLED', 'RPC listener startup cancelled')
}

export class RpcServer {
  #listener = createServer({ highWaterMark: LIMITS.callWindow })
  #methods = new MethodRegistry()
  #peers = new Set<RpcPeer>()
  #closing: Promise<void> | undefined

  private constructor(keepAliveInitialDelayMs: number, onPeer?: (peer: RpcPeer) => void) {
    this.#listener.on('connection', socket => {
      if (this.#closing) {
        socket.destroy()
        return
      }
      const peer = RpcPeer.accept(socket, this.#methods, keepAliveInitialDelayMs, onPeer,
        () => { this.#peers.delete(peer) })
      this.#peers.add(peer)
    })
    this.#listener.on('error', () => { void this.close() })
  }

  static async listen(options: RpcServerOptions): Promise<RpcServer> {
    const { signal } = options
    if (signal?.aborted) throw cancelled()
    const { host, port } = options
    const keepAliveInitialDelayMs = resolveKeepAliveInitialDelay(options.keepAliveInitialDelayMs)
    const server = new RpcServer(keepAliveInitialDelayMs, options.onPeer)
    const startup = signal && new AbortController()
    let disposeAbort: (() => void) | undefined
    try {
      for (const method of options.methods ?? []) server.register(method)
      if (signal && startup) {
        disposeAbort = observeAbort(signal, () => startup.abort(cancelled()))
        if (signal.aborted) throw cancelled()
      }
      server.#listener.listen({ host, port })
      await once(server.#listener, 'listening', { signal: startup?.signal })
      startup?.signal.throwIfAborted()
      return server
    } catch (error) {
      await server.close()
      if (startup?.signal.aborted && error instanceof Error && error.cause === startup.signal.reason) {
        throw startup.signal.reason
      }
      throw error
    } finally {
      disposeAbort?.()
    }
  }

  get address(): RpcAddress {
    const address = this.#listener.address()
    if (!address || typeof address === 'string') throw new RpcError('UNAVAILABLE', 'RPC server is not listening')
    return { host: address.address, port: address.port }
  }

  register(method: RpcMethod): () => Promise<void> {
    if (this.#closing) throw new RpcError('UNAVAILABLE', 'RPC server is closing or closed')
    return this.#methods.register(method)
  }

  close(): Promise<void> {
    if (!this.#closing) {
      const closing = deferred<void>()
      this.#closing = closing.promise
      void this.#shutdown().then(closing.resolve, closing.reject)
    }
    return this.#closing
  }

  async #shutdown(): Promise<void> {
    this.#methods.clear()
    const stopped = new Promise<void>(resolve => this.#listener.close(() => resolve()))
    await Promise.all([stopped, ...Array.from(this.#peers, peer => peer.close())])
  }
}
