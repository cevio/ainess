import { defineController } from '@ainess/http'

/** @type {import('@ainess/http/controllers').HttpControllerModule} */
export default (ctx) => ({
  method: 'GET',
  middlewares: [defineController(() => ctx.models.application.databaseReady(undefined, { caller: undefined }))],
})
