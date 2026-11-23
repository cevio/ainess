import { defineController } from '@ainess/http'

/** @type {import('@ainess/http/controllers').HttpControllerModule} */
const controller = () => ({
  method: 'GET',
  middlewares: [defineController({ handle: () => ({ ok: true }) })],
})

export default controller
