import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { HttpRouteMiddleware } from './index.js'

type RouteContext = Parameters<HttpRouteMiddleware>[0]
type ControllerHandler<Input> = (request: RouteContext, input: Input) => unknown

export interface HttpControllerInput extends Pick<RouteContext, 'params' | 'query'> {
  body: unknown
}

export interface HttpControllerOptions<Input> {
  schema: StandardSchemaV1<unknown, Input>
  handle: ControllerHandler<Input>
}

interface UnvalidatedControllerOptions {
  schema?: undefined
  handle: ControllerHandler<HttpControllerInput>
}

export function defineController(handle: ControllerHandler<HttpControllerInput>): HttpRouteMiddleware
export function defineController<Input>(options: HttpControllerOptions<Input>): HttpRouteMiddleware
export function defineController(options: UnvalidatedControllerOptions): HttpRouteMiddleware
export function defineController<Input>(
  controller: ControllerHandler<HttpControllerInput> | HttpControllerOptions<Input> | UnvalidatedControllerOptions,
): HttpRouteMiddleware {
  const options = 'handle' in controller ? controller : { handle: controller, schema: undefined }
  return async (request) => {
    const { body } = request.request as typeof request.request & { body?: unknown }
    const input: HttpControllerInput = { params: request.params, query: request.query, body }

    let result: unknown
    if (options.schema === undefined) {
      result = await options.handle(request, input)
    } else {
      const parsed = await options.schema['~standard'].validate(input)
      if (parsed.issues) return request.throw(400, 'Invalid request', { issues: parsed.issues })
      result = await options.handle(request, parsed.value)
    }

    if (result !== undefined) request.body = result
  }
}
