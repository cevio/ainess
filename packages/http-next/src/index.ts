import type { HttpPrepare } from '@ainess/http'
import nextModule from 'next'

// Next's public CommonJS entry is callable. Its declarations re-export a default.
const next = nextModule as unknown as typeof nextModule.default
const apiPrefixPattern = /^\/(?:[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*)$/

interface NextProjectOptions {
  dir?: string
  dev?: boolean
}

export interface HttpNextOptions extends NextProjectOptions {
  routing?: 'prefix'
  apiPrefix: string
}

export interface HttpNextKoaFirstOptions extends NextProjectOptions {
  routing: 'koa-first'
  apiPrefix?: never
}

export function httpNext(options: HttpNextOptions | HttpNextKoaFirstOptions): HttpPrepare {
  const { dir = process.cwd(), dev = process.env.NODE_ENV === 'development', routing = 'prefix', apiPrefix } = options
  if (routing !== 'prefix' && routing !== 'koa-first') {
    throw new TypeError('Unsupported HTTP Next.js routing mode')
  }
  if (routing === 'prefix' && (typeof apiPrefix !== 'string' || !apiPrefixPattern.test(apiPrefix))) {
    throw new TypeError('apiPrefix must contain one or more URL path segments, without a trailing slash')
  }

  return async (server, handleHttp) => {
    const app = next({ dir, dev, httpServer: server })
    try {
      await app.prepare()
      const handleNext = app.getRequestHandler()
      const dispose = () => app.close()
      if (routing === 'koa-first') return { handle: handleHttp, onRouteMiss: handleNext, dispose }

      const apiPath = `${apiPrefix}/`
      return {
        handle(request, response) {
          const path = request.url?.match(/^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)/i)?.[1]
          if (path === apiPrefix || path?.startsWith(apiPath)) return handleHttp(request, response)
          return handleNext(request, response)
        },
        dispose,
      }
    } catch (error) {
      try {
        await app.close()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Next.js startup and cleanup failed', { cause: error })
      }
      throw error
    }
  }
}
