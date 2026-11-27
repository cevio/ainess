import { isPromise } from 'node:util/types'
import { importModules, parseFileRoute, scanModules, type LoadModulesOptions } from '@ainess/loader'
import { RpcError, RpcMode, rpcPayloadLimit, type RpcMethod } from '@ainess/rpc'
import type { Context, FiberState } from '@deepseek-ai/cordis'

export type MicroControllerDefinition = {
  [Mode in RpcMode]: Omit<Extract<RpcMethod, { mode: Mode }>, 'name'>
}[RpcMode]

export type MicroControllerModule = (ctx: Context) => MicroControllerDefinition

export interface MicroControllersOptions extends Omit<LoadModulesOptions, 'suffix'> {
  prefix?: string
}

// Cordis exports FiberState as a const enum in its declarations only.
const unloading: FiberState.UNLOADING = 5

function controllerError(file: string, cause: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  return new Error(`Failed to load Micro controller ${file}${detail}`, { cause })
}

function methodName(stem: string, prefix: string, source: string): string {
  const segments = parseFileRoute(stem, { prefix, source })
  const name = segments.map((segment) => {
    if (segment.kind !== 'static') throw new TypeError('Micro controller paths must use static segments')
    return segment.value
  }).join('.') || 'index'
  rpcPayloadLimit(name)
  return name
}

function createMethod(name: string, value: unknown): RpcMethod {
  if (isPromise(value)) {
    void value.catch(() => {})
    throw new TypeError('A controller factory must return its definition synchronously')
  }
  if (typeof value !== 'object' || value === null || !('mode' in value)) {
    throw new TypeError('A controller must specify an RPC mode')
  }
  const { mode } = value
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < RpcMode.Unary || mode > RpcMode.Bidi) {
    throw new TypeError('A controller must specify a valid RPC mode')
  }
  const handle = 'handle' in value ? value.handle : undefined
  if (typeof handle !== 'function') throw new TypeError('A controller must provide a handle function')
  return { name, mode, handle } as RpcMethod
}

export async function loadMicroControllers(
  ctx: Context,
  { directory, extensions, prefix = '' }: MicroControllersOptions,
): Promise<readonly RpcMethod[]> {
  if (typeof prefix !== 'string' || /^\.|\.\.|\.$|\//.test(prefix)) {
    throw new TypeError('Micro controller prefix must use non-empty dot-separated segments')
  }
  const routePrefix = prefix ? `/${prefix.replaceAll('.', '/')}` : ''
  if (prefix) {
    try {
      methodName('index', routePrefix, 'Micro controller prefix')
    } catch (cause) {
      throw controllerError('prefix', cause)
    }
  }

  const loading = new AbortController()
  const { signal } = loading
  const cancel = () => loading.abort(new RpcError('CANCELLED', 'Micro controller loading cancelled'))
  const { fiber } = ctx
  const owner = fiber.ctx
  // Cordis 4.1 can defer state changes and child teardown until a superseded startup settles.
  const epochs = new Map([[fiber, fiber['_runner'].epoch]])
  let parent = fiber.parent.fiber
  while (!epochs.has(parent)) {
    epochs.set(parent, parent['_runner'].epoch)
    parent = parent.parent.fiber
  }
  const committed = fiber.committed
  const dependencyNames = Object.keys(fiber.inject)
  const scopeChanged = () => {
    for (const [scope, epoch] of epochs) {
      if (scope.uid === null || scope.state === unloading || scope['_runner'].epoch !== epoch) return true
    }
    return false
  }
  const dependencyChanged = (name: string) => {
    const expected = committed?.[name]
    // Bound implementations can have undefined values. Compare their identities instead.
    if (!expected || owner.reflect._getImpl(name) !== expected) return true
    try {
      return !!expected.check && !expected.check.call(owner.get(name))
    } catch {
      return true
    }
  }
  const checkLoading = (checkDependencies = false) => {
    if (!signal.aborted && (scopeChanged() || fiber.committed !== committed
      || (checkDependencies && dependencyNames.some(dependencyChanged)))) cancel()
    signal.throwIfAborted()
  }
  checkLoading(true)

  let releasing = false
  const stopPreparing = owner.effect(function* () {
    yield () => {
      if (!releasing) cancel()
    }
    yield owner.on('internal/plugin', (changed) => {
      if (changed.uid === null && epochs.has(changed)) cancel()
    })
    yield owner.on('internal/service', (name) => {
      if (!signal.aborted && Object.hasOwn(fiber.inject, name) && dependencyChanged(name)) cancel()
    })
  }, 'loadMicroControllers.prepare()')

  try {
    checkLoading()
    const files = await scanModules({ directory, suffix: 'rpc', extensions })
    checkLoading()
    const sources = new Map<string, string>()
    const names = files.map(({ stem, relativePath }) => {
      let name: string
      try {
        name = methodName(stem, routePrefix, relativePath)
      } catch (cause) {
        throw controllerError(relativePath, cause)
      }
      const previous = sources.get(name)
      if (previous !== undefined) {
        throw new TypeError(`Duplicate RPC method "${name}" in ${previous} and ${relativePath}`)
      }
      sources.set(name, relativePath)
      return name
    })

    const modules = []
    for (const file of files) {
      checkLoading()
      const [module] = await importModules([file], (value) => {
        if (typeof value !== 'function') throw new TypeError('The default export must be a controller factory')
        return value as (ctx: Context) => unknown
      }, signal)
      modules.push(module)
    }
    const methods: RpcMethod[] = []
    for (const [index, { file, value: create }] of modules.entries()) {
      checkLoading()
      try {
        methods.push(createMethod(names[index], create(ctx)))
      } catch (cause) {
        checkLoading()
        throw controllerError(file.relativePath, cause)
      }
    }
    checkLoading()
    return methods
  } finally {
    releasing = true
    await stopPreparing()
    // Disposal or a dependency transition can occur while the temporary hooks are being released.
    checkLoading(true)
  }
}
