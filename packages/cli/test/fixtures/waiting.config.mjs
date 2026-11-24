import { defineApp, use } from '@ainess/framework'

export default defineApp({
  plugins: {
    pending: use({ inject: ['lateService'], apply() { throw new Error('Unexpected service') } }),
    setup: use((ctx) => {
      ctx.effect(() => () => { console.log('startup resources closed') })
      console.log('waiting for a service')
    }),
  },
})
