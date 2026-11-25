import { deferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import { methodNameLength } from './messages.js'
import { RpcError, RpcMode } from './types.js'
import type { RpcMethod } from './types.js'

export type RegisteredMethod = RpcMethod & {
  active: number
  drained?: Deferred<void>
  unregister: () => Promise<void>
}

export class MethodRegistry {
  #methods = new Map<string, RegisteredMethod>()
  #closed = false

  get(name: string): RegisteredMethod | undefined {
    return this.#methods.get(name)
  }

  register(method: RpcMethod): () => Promise<void> {
    const { name, mode, handle } = method
    methodNameLength(name)
    this.#checkRegistration(name)
    if (!Number.isInteger(mode) || mode < RpcMode.Unary || mode > RpcMode.Bidi || typeof handle !== 'function') {
      throw new RpcError('INVALID_ARGUMENT', 'Invalid RPC method definition')
    }
    const bound = Function.prototype.bind.call(handle, method)
    // Binding can run user code that synchronously closes or changes the registry.
    this.#checkRegistration(name)

    let methods: Map<string, RegisteredMethod> | undefined = this.#methods
    let registration: RegisteredMethod | undefined
    let removed: Promise<void> | undefined
    const unregister = () => {
      if (removed) return removed
      methods?.delete(name)
      methods = undefined
      const active = registration
      registration = undefined
      if (!active?.active) return removed = Promise.resolve()
      active.drained = deferred<void>()
      return removed = active.drained.promise
    }
    const entry: RegisteredMethod = { name, mode, handle: bound, active: 0, unregister }
    registration = entry
    methods.set(name, entry)
    return unregister
  }

  clear(): void {
    this.#closed = true
    for (const method of this.#methods.values()) void method.unregister()
  }

  #checkRegistration(name: string): void {
    if (this.#closed) throw new RpcError('UNAVAILABLE', 'RPC method registry is closed')
    if (this.#methods.has(name)) throw new RpcError('INVALID_ARGUMENT', 'Duplicate RPC method name')
  }
}
