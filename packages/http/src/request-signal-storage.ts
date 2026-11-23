import { AsyncLocalStorage } from 'node:async_hooks'

// A bundled Next.js handler and the host can load separate copies in one Node runtime.
const storageKey = Symbol.for('@ainess/http/request-signal')
const globals = globalThis as typeof globalThis & { [storageKey]?: AsyncLocalStorage<AbortSignal> }

export const requestSignalStorage = globals[storageKey] ??= new AsyncLocalStorage<AbortSignal>()
