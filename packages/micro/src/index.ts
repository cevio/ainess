import type { Context } from '@deepseek-ai/cordis'
import { createMicroClient } from './client.js'
import type { MicroClient, MicroOptions } from './client.js'

export { createMicroClient }
export type {
  MicroCircuitBreakerOptions, MicroClient, MicroDiscovery, MicroOptions, MicroStreamOptions, MicroTimingEvent,
} from './client.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly micro: MicroClient
  }
}

export async function micro(ctx: Context, options: MicroOptions): Promise<void> {
  await ctx.effect(async () => {
    const client = createMicroClient(options)
    try {
      ctx.provide('micro', client)
    } catch (error) {
      await client.close()
      throw error
    }
    return () => client.close()
  }, 'micro')
}
