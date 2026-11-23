import { defineController } from '@ainess/http'

/** @type {import('@ainess/http/controllers').HttpControllerModule} */
const controller = () => ({
  method: 'GET',
  middlewares: [defineController({ handle: (_request, input) => ({
    parts: input.params.parts,
    hasWildcard: Object.hasOwn(input.params, '*'),
  }) })],
})

export default controller
