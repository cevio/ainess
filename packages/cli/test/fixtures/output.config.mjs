import { defineApp, use } from '@ainess/framework'

const output = 'x'.repeat(2 * 1024 * 1024)

export default defineApp({
  plugins: {
    logger: use((ctx) => {
      ctx.effect(() => () => {
        process.stdout.write(output)
        process.stderr.write(output)
      })
    }),
  },
})
