import type { RpcAddress } from '@ainess/registry-shared'
import type { Context } from '@deepseek-ai/cordis'
import { RegistryClient } from './client.js'

export { RegistryClient }
export type { RegistryClientOptions, RegistryClientState, RegistryDiscovery } from './client.js'
export type { PickQuery, RegistrationRequest, RegisterResponse, RpcAddress, ServiceQuery } from '@ainess/registry-shared'

export interface RegistryOptions {
  address: RpcAddress
  timeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly registryClient: RegistryClient
  }
}

export async function registry(ctx: Context, options: RegistryOptions): Promise<void> {
  await ctx.effect(async () => {
    const startup = new AbortController()
    const stopWatching = ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) startup.abort()
    })
    let client: RegistryClient | undefined
    const close = async () => { await client?.close() }
    try {
      client = await RegistryClient.connect(options.address, {
        signal: startup.signal,
        timeoutMs: options.timeoutMs,
      })
      if (startup.signal.aborted) await close()
      else ctx.provide('registryClient', client)
    } catch (error) {
      await close()
      if (!startup.signal.aborted) throw error
    } finally {
      stopWatching()
    }
    return close
  }, 'registry.connect()')
}
