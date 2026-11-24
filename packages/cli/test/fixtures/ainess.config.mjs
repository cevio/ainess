import { defineApp, use } from '@ainess/framework'
import { http, httpListener } from '@ainess/http'

export default defineApp({
  plugins: {
    http: use(http),
    routes: use(Object.assign(
      /** @param {import('@deepseek-ai/cordis').Context} ctx */
      (ctx) => { ctx.http.route('GET', '/status', (request) => { request.body = 'ready' }) },
      { inject: ['http'] },
    )),
  },
  entries: {
    web: use(httpListener, {
      host: '127.0.0.1',
      port: 0,
      prepare(server, handle) {
        server.once('listening', () => {
          const address = server.address()
          if (address && typeof address === 'object') console.log(`http://127.0.0.1:${address.port}`)
        })
        return { handle, dispose: () => { console.log('listener disposed') } }
      },
    }),
  },
})
