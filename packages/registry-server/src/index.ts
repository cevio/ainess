import { RpcError, RpcMode, RpcServer } from '@ainess/rpc'
import type { RpcMethod } from '@ainess/rpc'
import {
  decodeRegistryMessage, encodeRegistryListBatches, encodeRegistryMessage, parsePickQuery, parseRegistration,
  parseServiceQuery, registryKeepAliveInitialDelayMs, registryMethods,
} from '@ainess/registry-shared'
import type { RpcAddress } from '@ainess/registry-shared'
import type { Context } from '@deepseek-ai/cordis'
import { RegistryDirectory } from './directory.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly registryServer: RegistryServer
  }
}

function parseRequest<T>(data: Uint8Array, parse: (value: unknown) => T): T {
  try {
    return parse(decodeRegistryMessage(data))
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause
    throw new RpcError('INVALID_ARGUMENT', cause.message, { cause })
  }
}

async function* listBatches(addresses: RpcAddress[]): AsyncIterable<Uint8Array> {
  yield* encodeRegistryListBatches(addresses)
}

export class RegistryServer {
  private constructor(private readonly rpc: RpcServer) {}

  static async listen(address: RpcAddress, options?: { signal?: AbortSignal }): Promise<RegistryServer> {
    const directory = new RegistryDirectory()
    const methods: RpcMethod[] = [
      {
        name: registryMethods.register,
        mode: RpcMode.Unary,
        handle({ data, peer }) {
          const request = parseRequest(data, parseRegistration)
          directory.register(peer, request)
          return encodeRegistryMessage({ registered: request.services })
        },
      },
      {
        name: registryMethods.unregister,
        mode: RpcMode.Unary,
        handle({ data, peer }) {
          const request = parseRequest(data, parseRegistration)
          return encodeRegistryMessage({ removed: directory.unregister(peer, request) })
        },
      },
      {
        name: registryMethods.list,
        mode: RpcMode.ServerStream,
        handle({ data }) {
          const { service } = parseRequest(data, parseServiceQuery)
          return listBatches(directory.list(service))
        },
      },
      {
        name: registryMethods.pick,
        mode: RpcMode.Unary,
        handle({ data }) {
          const query = parseRequest(data, parsePickQuery)
          return encodeRegistryMessage(directory.pick(query))
        },
      },
    ]
    const rpc = await RpcServer.listen({
      host: address.host,
      port: address.port,
      methods,
      signal: options?.signal,
      keepAliveInitialDelayMs: registryKeepAliveInitialDelayMs,
      onPeer(peer) {
        peer.onClose(() => directory.disconnect(peer))
      },
    })
    return new RegistryServer(rpc)
  }

  get address(): RpcAddress {
    return this.rpc.address
  }

  close(): Promise<void> {
    return this.rpc.close()
  }
}

export async function registryServer(ctx: Context, address: RpcAddress): Promise<void> {
  await ctx.effect(async () => {
    const startup = new AbortController()
    const stopWatching = ctx.on('internal/plugin', (fiber) => {
      if (fiber === ctx.fiber && fiber.uid === null) startup.abort()
    })
    let server: RegistryServer | undefined
    const close = async () => { await server?.close() }
    try {
      server = await RegistryServer.listen(address, { signal: startup.signal })
      if (startup.signal.aborted) await close()
      else ctx.provide('registryServer', server)
    } catch (error) {
      await close()
      if (!startup.signal.aborted) throw error
    } finally {
      stopWatching()
    }
    return close
  }, 'registryServer')
}
