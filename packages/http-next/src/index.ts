import { createServer } from 'node:http'
import type { HttpPrepare, HttpUpgradeHandler } from '@ainess/http'
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
  if (routing === 'koa-first' && apiPrefix !== undefined) {
    throw new TypeError('apiPrefix can only be used with prefix routing')
  }

  return async (_server, handleHttp) => {
    // Next registers its own upgrade listener on the supplied server on the first Next request.
    const upgrades = createServer()
    const app = next({ dir, dev, httpServer: upgrades })
    try {
      await app.prepare()
      const handleNext = app.getRequestHandler()
      const onUpgrade: HttpUpgradeHandler = ({ request, socket, head }) => {
        return upgrades.emit('upgrade', request, socket, head)
      }
      const dispose = () => app.close()
      if (routing === 'koa-first') return { handle: handleHttp, onRouteMiss: handleNext, onUpgrade, dispose }

      const apiPath = `${apiPrefix}/`
      return {
        handle(request, response) {
          const path = request.url?.match(/^(?:https?:\/\/[^/?#]+)?(\/[^?#]*)/i)?.[1]
          if (path === apiPrefix || path?.startsWith(apiPath)) return handleHttp(request, response)
          return handleNext(request, response)
        },
        onUpgrade,
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
