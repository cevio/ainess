import { isPromise } from 'node:util/types'
import { importModules, parseFileRoute, scanModules, type LoadModulesOptions } from '@ainess/loader'
import type { Context } from '@deepseek-ai/cordis'
import type { HttpMethod, HttpRouteMiddleware } from './index.js'
import { registerRoute } from './route.js'

export interface HttpControllerDefinition {
  readonly method: HttpMethod
  readonly middlewares: readonly [HttpRouteMiddleware, ...HttpRouteMiddleware[]]
}

export type HttpControllerModule = (
  ctx: Context,
) => HttpControllerDefinition | readonly [HttpControllerDefinition, ...HttpControllerDefinition[]]

export interface HttpControllersOptions extends Omit<LoadModulesOptions, 'suffix'> {
  prefix?: string
}

function controllerError(file: string, cause: unknown): Error {
  const detail = cause instanceof Error ? `: ${cause.message}` : ''
  return new Error(`Failed to load HTTP controller ${file}${detail}`, { cause })
}

export async function loadHttpControllers(
  ctx: Context,
  { directory, extensions, prefix = '' }: HttpControllersOptions,
): Promise<void> {
  if (prefix) parseFileRoute('index', { prefix, source: 'HTTP controller prefix' })
  let cancelled = false
  const stopPreparing = ctx.effect(function* () {
    yield () => { cancelled = true }
    yield ctx.on('internal/service', (name) => {
      if ((name === 'http' || Object.hasOwn(ctx.fiber.inject, name)) && ctx.get(name) === undefined) {
        cancelled = true
      }
    })
  }, 'loadHttpControllers.prepare()')

  try {
    const files = await scanModules({ directory, suffix: 'controller', extensions })
    if (cancelled || ctx.fiber.uid === null) return

    const fileRoutes = files.map(file => {
      const segments = parseFileRoute(file.stem, { prefix, source: file.relativePath })
      const path = '/' + segments.map((segment) => {
        if (segment.kind === 'static') return segment.value
        if (segment.kind === 'parameter') return `:${segment.name}`
        return '*'
      }).join('/')
      const last = segments.at(-1)
      return { path, catchAllName: last?.kind === 'catch-all' ? last.name : undefined }
    })

    const modules = await importModules(files, (value) => {
      if (typeof value !== 'function') throw new TypeError('The default export must be a controller factory')
      return value as (ctx: Context) => unknown
    })
    if (cancelled || ctx.fiber.uid === null) return

    const routes: {
      file: string
      path: string
      method: HttpMethod
      middlewares: HttpRouteMiddleware[]
      catchAllName?: string
    }[] = []
    for (const [index, { file, value: create }] of modules.entries()) {
      const { path, catchAllName } = fileRoutes[index]
      try {
        const result = create(ctx)
        if (isPromise(result)) {
          void result.catch(() => {})
          throw new TypeError('A controller factory must return its definitions synchronously')
        }
        const definitions: readonly unknown[] = Array.isArray(result) ? result : [result]
        if (!definitions.length) throw new TypeError('The factory must return at least one controller')

        for (const definition of definitions) {
          if (typeof definition !== 'object' || definition === null || !('method' in definition)
            || typeof definition.method !== 'string') {
            throw new TypeError('A controller must specify one HTTP method')
          }
          const middleware = 'middlewares' in definition ? definition.middlewares : undefined
          const middlewares = Array.isArray(middleware) ? [...middleware] : []
          if (!middlewares.length || middlewares.some(fn => typeof fn !== 'function')) {
            throw new TypeError('A controller must provide a non-empty list of middleware functions')
          }
          routes.push({
            path,
            file: file.relativePath,
            method: definition.method as HttpMethod,
            middlewares: middlewares as HttpRouteMiddleware[],
            catchAllName,
          })
        }
      } catch (cause) {
        throw controllerError(file.relativePath, cause)
      }
    }

    if (!routes.length) return
    ctx.effect(function* () {
      for (const { file, method, path, middlewares, catchAllName } of routes) {
        try {
          yield ctx.http[registerRoute](method, path, middlewares, catchAllName)
        } catch (cause) {
          throw controllerError(file, cause)
        }
      }
    }, 'loadHttpControllers()')
  } finally {
    await stopPreparing()
  }
}
