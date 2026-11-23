import type { Context } from '@deepseek-ai/cordis'
import { Cluster, Redis, type ClusterNode, type ClusterOptions, type RedisOptions } from 'ioredis'

export type IoredisOptions =
  | (RedisOptions & { startupNodes?: never; clusterOptions?: never })
  | ({ startupNodes: ClusterNode[]; clusterOptions?: ClusterOptions } & { [Key in keyof RedisOptions]?: never })

declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly ioredis: InstanceType<typeof Redis> | InstanceType<typeof Cluster>
  }
}

function pauseStartupRetry(client: Context['ioredis']): () => void {
  if (client instanceof Cluster) {
    const retry = client.options.clusterRetryStrategy
    client.options.clusterRetryStrategy = null
    return () => { client.options.clusterRetryStrategy = retry }
  }

  const retry = client.options.retryStrategy
  client.options.retryStrategy = null
  return () => { client.options.retryStrategy = retry }
}

export async function ioredis(ctx: Context, options: IoredisOptions = {}): Promise<void> {
  const { startupNodes, clusterOptions, ...redisOptions } = options
  if (startupNodes === undefined && (Object.hasOwn(options, 'startupNodes') || clusterOptions !== undefined)) {
    throw new TypeError('startupNodes is required for Redis Cluster')
  }
  if (startupNodes !== undefined && Object.values(redisOptions).some((value) => value !== undefined)) {
    throw new TypeError('Use clusterOptions for Redis Cluster configuration')
  }

  const client = startupNodes === undefined
    ? new Redis({ ...redisOptions, lazyConnect: true })
    : new Cluster(startupNodes, { ...clusterOptions, lazyConnect: true })
  ctx.provide('ioredis', client)

  await ctx.effect(async () => {
    let closing: Promise<unknown> | undefined
    const disconnect = () => {
      if (!closing && (client instanceof Cluster || client.status !== 'end')) {
        const connections = client instanceof Cluster ? client.nodes() : [client]
        closing = Promise.all(connections.map(({ stream }) => {
          if (!stream || stream.destroyed) return
          return new Promise<void>((resolve) => stream.once('close', () => resolve()))
        }))
        if (client instanceof Cluster) {
          // A pending readiness check can emit ready even after the node pool has closed.
          client.once('ready', () => client.disconnect())
          client.disconnect()
          if (client.options.slotsRefreshInterval) {
            // An in-flight refresh can rearm its timer. With the pool closed, an idle refresh completes synchronously.
            let waitingForRefresh = false
            client.refreshSlotsCache(() => {
              if (waitingForRefresh) client.disconnect()
            })
            waitingForRefresh = true
          }
        } else {
          client.disconnect()
        }
      }
      return closing
    }
    const restoreRetry = pauseStartupRetry(client)

    // Cluster.connect() can stay pending during discovery or after a failed readiness check.
    let stopClusterStartup: (() => void) | undefined
    const clusterStopped = client instanceof Cluster
      ? new Promise<never>((_, reject) => {
        stopClusterStartup = () => reject(new Error('Redis Cluster disconnected before becoming ready'))
        client.once('end', stopClusterStartup)
      })
      : undefined

    // Cordis drains the startup task before it runs the effect disposer.
    const stopWatching = ctx.on('internal/plugin', (fiber) => {
      if (fiber !== ctx.fiber || fiber.uid !== null) return
      stopClusterStartup?.()
      return disconnect()
    })
    try {
      const connecting = client.connect()
      await (clusterStopped ? Promise.race([connecting, clusterStopped]) : connecting)
    } catch (error) {
      await disconnect()
      if (ctx.fiber.uid !== null) throw error
    } finally {
      stopWatching()
      if (stopClusterStartup) client.off('end', stopClusterStartup)
      restoreRetry()
    }
    return disconnect
  })
}
