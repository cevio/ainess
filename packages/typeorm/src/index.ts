import type { Context } from '@deepseek-ai/cordis'
import { DataSource, type DataSourceOptions } from 'typeorm'

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly typeorm: DataSource
  }
}

export async function typeorm(ctx: Context, options: DataSourceOptions): Promise<void> {
  const dataSource = new DataSource(options)
  ctx.provide('typeorm', dataSource)

  await ctx.effect(async () => {
    await dataSource.initialize()
    return () => dataSource.destroy()
  })
}
