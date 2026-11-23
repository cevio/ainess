import { defineController } from '@ainess/http'

/** @type {import('@ainess/http/controllers').HttpControllerModule} */
const controller = (ctx) => [
  {
    method: 'GET',
    middlewares: [defineController({ handle: (_request, input) => ({
      id: input.params.id,
      greeting: ctx.get('greeting'),
    }) })],
  },
  {
    method: 'POST',
    middlewares: [defineController({ handle: (request, input) => {
      request.status = 201
      return { id: input.params.id }
    } })],
  },
]

export default controller
