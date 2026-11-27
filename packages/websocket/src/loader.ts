import { isPromise } from 'node:util/types'
import { importModules, parseFileRoute, scanModules, type LoadModulesOptions, type ModuleFile } from '@ainess/loader'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import { registerRoute } from './route.js'
import type { WebSocketRoute } from './types.js'

export type WebSocketRouteModule<State = undefined> = (ctx: Context) => WebSocketRoute<State>

export interface WebSocketRoutesOptions extends Omit<LoadModulesOptions, 'suffix'> {
  prefix?: string
}

export interface WebSocketRouteDirectoryOptions extends WebSocketRoutesOptions {
  inject?: readonly string[]
}

// Cordis exposes FiberState as a const enum in its declarations.
const unloading: FiberState.UNLOADING = 5

export function websocketRoutes({ inject = [], ...options }: WebSocketRouteDirectoryOptions) {
  const names: string[] | undefined = Array.isArray(inject) ? ['websocket', ...inject] : undefined
  if (!names || names.some(name => typeof name !== 'string' || !name)) {
    throw new TypeError('WebSocket route inject must be an array of non-empty service names')
  }
  return {
    name: 'websocket-routes',
    inject: [...new Set(names)],
    apply: (ctx: Context) => loadWebSocketRoutes(ctx, options),
  }
}

function sourceError(file: string, cause: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  return new Error(`Failed to load WebSocket route ${file}${detail}`, { cause })
}

function filePath(stem: string, prefix: string, source: string): string {
  const parts = parseFileRoute(stem, { prefix, source })
  const url = new URL('ws://localhost')
  url.pathname = '/' + parts.map((segment) => {
    if (segment.kind !== 'static') throw new TypeError('WebSocket file routes must use static path segments')
    if (/^(?:\.|%2e){1,2}$/i.test(segment.value)) {
      throw new TypeError('WebSocket file routes cannot contain an encoded dot segment')
    }
    if (/[\u0000-\u001f\u007f]/u.test(segment.value)) {
      throw new TypeError('WebSocket file routes cannot contain control characters')
    }
    return segment.value
  }).join('/')
  return url.pathname
}

export async function loadWebSocketRoutes(
  ctx: Context,
  { directory, extensions, prefix = '' }: WebSocketRoutesOptions,
): Promise<void> {
  if (typeof prefix !== 'string') throw new TypeError('WebSocket route prefix must be a string')
  if (prefix) {
    try {
      filePath('index', prefix, 'prefix')
    } catch (cause) {
      throw sourceError('prefix', cause)
    }
  }

  const { fiber } = ctx
  const loading = new AbortController()
  const { signal } = loading
  const cancel = () => loading.abort()
  // Cordis 4.1 can defer scope teardown until superseded startup work settles.
  const scopes = new Map([[fiber, fiber['_runner'].epoch]])
  for (let parent = fiber.parent.fiber; !scopes.has(parent); parent = parent.parent.fiber) {
    scopes.set(parent, parent['_runner'].epoch)
  }
  const dependencies = new Map(['websocket', ...Object.keys(fiber.inject)].map(name => {
    return [name, ctx.reflect._getImpl(name)] as const
  }))
  if (!dependencies.get('websocket')) throw new Error('WebSocket route loading requires the websocket service')

  function check() {
    for (const [scope, epoch] of scopes) {
      if (scope.uid === null || scope.state === unloading || scope['_runner'].epoch !== epoch) cancel()
    }
    for (const [name, binding] of dependencies) {
      if (ctx.reflect._getImpl(name) !== binding) cancel()
    }
    signal.throwIfAborted()
  }

  const stopWatching = ctx.effect(function* () {
    yield cancel
    yield ctx.on('internal/plugin', (changed) => {
      if (scopes.has(changed) && changed.uid === null) cancel()
    })
    yield ctx.on('internal/service', (name) => {
      if (dependencies.has(name) && ctx.reflect._getImpl(name) !== dependencies.get(name)) cancel()
    })
  }, 'loadWebSocketRoutes.prepare()')

  try {
    check()
    const files = await scanModules({ directory, suffix: 'ws', extensions })
    check()
    const filesByPath = new Map<string, ModuleFile>()
    for (const file of files) {
      const { stem, relativePath } = file
      let path: string
      try {
        path = filePath(stem, prefix, relativePath)
      } catch (cause) {
        throw sourceError(relativePath, cause)
      }
      const previous = filesByPath.get(path)
      if (previous) {
        throw new Error(`Duplicate WebSocket route ${path} in ${previous.relativePath} and ${relativePath}`)
      }
      filesByPath.set(path, file)
    }

    const modules = []
    for (const [path, file] of filesByPath) {
      check()
      const [module] = await importModules([file], (value) => {
        if (typeof value !== 'function') throw new TypeError('The default export must be a WebSocket route factory')
        return value as (ctx: Context) => unknown
      }, signal)
      modules.push({ path, file: file.relativePath, factory: module.value })
    }
    const routes = modules.map(({ path, file, factory }) => {
      check()
      try {
        const endpoint = factory(ctx)
        const promise = isPromise(endpoint)
        if (promise) void endpoint.catch(() => {})
        if (promise || typeof (endpoint as { then?: unknown } | null)?.then === 'function') {
          throw new TypeError('A WebSocket route factory must return an endpoint synchronously')
        }
        return { path, file, endpoint }
      } catch (cause) {
        throw sourceError(file, cause)
      }
    })
    check()
    if (!routes.length) return
    ctx.effect(function* () {
      for (const { file, path, endpoint } of routes) {
        check()
        try {
          yield ctx.websocket[registerRoute](path, endpoint)
        } catch (cause) {
          throw sourceError(file, cause)
        }
      }
      check()
    }, 'loadWebSocketRoutes()')
  } catch (error) {
    if (!signal.aborted || error !== signal.reason) throw error
  } finally {
    await stopWatching()
  }
}
