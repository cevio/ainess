import { defineApp, use } from '../dist/index.js'
import type { Context } from '@deepseek-ai/cordis'
import type { InferModel } from '@ainess/model'
import application from './fixtures/models/application.model.js'

declare module '@ainess/model' {
  interface ModelTypes {
    application: InferModel<typeof application>
  }
}

function required(_ctx: Context, _options: { port: number }) {}
function optional(_ctx: Context, _options: { host?: string } = {}) {}

defineApp({
  plugins: { optional: use(optional), disabled: false },
  entries: { first: use(required, { port: 0 }), second: use(optional, { host: '127.0.0.1' }) },
})

defineApp(() => ({ plugins: { optional: use(optional), disabled: false } }))
defineApp(async ({ signal }) => {
  signal?.throwIfAborted()
  return { entries: { first: use(required, { port: 0 }), disabled: false } }
})

// @ts-expect-error The factory must return an application config.
defineApp(() => 42)

// @ts-expect-error Required Cordis plugin options must be supplied.
use(required)
// @ts-expect-error Options use the plugin's own types.
use(required, { port: '3000' })
