import type { HttpUpgradeHandler } from '@ainess/http'
import type { Context } from '@deepseek-ai/cordis'
import { createIngress } from './service.js'

export const websocketHttp = {
  name: 'websocket-http',
  inject: ['http', 'websocket'],
  apply(ctx: Context): void {
    const ingress = ctx.websocket[createIngress]()
    const handleUpgrade: HttpUpgradeHandler = ingress.handleUpgrade
    ctx.effect(() => ingress.close, 'websocket.http.connections')
    ctx.http.registerUpgrade(handleUpgrade)
  },
}
