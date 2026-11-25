import { deferred } from './deferred.js'
import type { Deferred } from './deferred.js'
import { methodNameLength } from './messages.js'
import { RpcError, RpcMode } from './types.js'
import type { RpcMethod } from './types.js'

export type RegisteredMethod = RpcMethod & {
  active: number
  drained?: Deferred<void>
}

export class MethodRegistry {
  #methods = new Map<string, RegisteredMethod>()

  get(name: string): RegisteredMethod | undefined {
    return this.#methods.get(name)
  }

  register(method: RpcMethod): () => Promise<void> {
    const { name, mode, handle } = method
    methodNameLength(name)
    if (this.#methods.has(name)) throw new RpcError('INVALID_ARGUMENT', 'Duplicate RPC method name')
    if (!Number.isInteger(mode) || mode < RpcMode.Unary || mode > RpcMode.Bidi || typeof handle !== 'function') {
      throw new RpcError('INVALID_ARGUMENT', 'Invalid RPC method definition')
    }
    const registration: RegisteredMethod = {
      name,
      mode,
      handle: Function.prototype.bind.call(handle, method),
      active: 0,
    }
    this.#methods.set(name, registration)
    let removed: Promise<void> | undefined
    return () => {
      if (removed) return removed
      if (this.#methods.get(name) === registration) this.#methods.delete(name)
      if (registration.active === 0) return removed = Promise.resolve()
      registration.drained = deferred<void>()
      return removed = registration.drained.promise
    }
  }

  clear(): void {
    this.#methods.clear()
  }
}
