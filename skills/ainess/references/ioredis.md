# @ainess/ioredis

宿主提供兼容的 ioredis 版本。用 `use(ioredis, options)` 安装，消费者声明 `inject: ['ioredis']` 并复用 `ctx.ioredis`。单节点或 Sentinel 直接传 `RedisOptions`。Cluster 使用 `{ startupNodes, clusterOptions }`，节点认证和 TLS 配置放入 `clusterOptions.redisOptions`。集群多键命令所用的键应在同一槽位。首次连接失败由启动任务报告，运行期按原生 ioredis 策略重连，关闭归提供者。 [ioredis 手册](https://github.com/cevio/ainess/blob/main/packages/ioredis/README.md)

## 执行 Redis 命令

宿主安装 `@ainess/ioredis`、`@deepseek-ai/cordis` 和 ioredis。启动监听在 `127.0.0.1:6379` 的 Redis，将以下内容保存为 `redis.mjs`。运行 `node redis.mjs` 应输出 `PONG`。

```js
import { ioredis } from '@ainess/ioredis'
import { Context } from '@deepseek-ai/cordis'

const ctx = new Context()
try {
  await ctx.plugin(ioredis, { host: '127.0.0.1', port: 6379 }).await()
  await ctx.plugin({
    inject: ['ioredis'],
    async apply(ctx) {
      console.log(await ctx.ioredis.ping())
    },
  }).await()
} finally {
  await ctx.fiber.dispose()
}
```

## 加入 Redis

宿主提供 `@ainess/ioredis` 和 ioredis。从 `@ainess/ioredis` 导入 `ioredis`，在 `plugins` 中装配以下安装项之一。业务插件声明 `inject: ['ioredis']`，Model 方法也可以把该键加入自己的 `inject`。使用已有连接执行 `ping()` 等原生命令。

```js
import { use } from '@ainess/framework'
import { ioredis } from '@ainess/ioredis'

const redis = use(ioredis, { host: '127.0.0.1', port: 6379 })
const redisCluster = use(ioredis, {
  startupNodes: [{ host: '127.0.0.1', port: 7000 }],
  clusterOptions: { scaleReads: 'master' },
})
```

用 Sentinel 时传原生 `sentinels` 与 `name`。Cluster 的节点级选项放到 `clusterOptions.redisOptions`，多键操作先确认槽位约束。工作区的 TypeORM 1.1.3 与 ioredis 同用时选择 ioredis 5.11.1 起的 5.x。对每个已配置的服务复用一个托管提供者，关闭时依赖方先完成清理。

ioredis 5.11.1 的 Cluster 启用 `stringNumbers` 时可能漏载槽位，同时开启 `enableAutoPipelining` 会导致访问缺失槽位的命令报错。 [客户端选项兼容说明](https://github.com/cevio/ainess/blob/main/packages/ioredis/README.md#租约锁限流和幂等)

TypeScript 应用使用 ioredis 6.1.0 且配置了 pnpm `hoist: false` 时，在宿主运行 `pnpm add -D @types/redis-errors`，供 ioredis 的公开错误声明解析。 [框架插件装配](framework.md) · [TypeORM 数据源](typeorm.md)

## 在消费插件中使用锁、限流和幂等

三个能力共用宿主创建的客户端。单节点或 Sentinel 使用 `keyPrefix`，Cluster 使用 `clusterOptions.keyPrefix`。键形如 `<keyPrefix>lock:…`、`<keyPrefix>rate-limit:…` 或 `<keyPrefix>idempotency:…`。启动本机 Redis 后，将示例保存为 `redis-operations.mjs`，运行 `node redis-operations.mjs` 应输出 `42`。

```js
import { Context } from '@deepseek-ai/cordis'
import { ioredis } from '@ainess/ioredis'
import { createRedisLock } from '@ainess/ioredis/lock'
import { createRedisRateLimiter } from '@ainess/ioredis/rate-limit'
import { createRedisIdempotency } from '@ainess/ioredis/idempotency'

const app = new Context()
try {
  await app.plugin(ioredis, { port: Number(process.env.REDIS_PORT ?? 6379), keyPrefix: 'demo:' }).await()
  await app.plugin({
    inject: ['ioredis'],
    async apply(ctx) {
      const lock = createRedisLock(ctx.ioredis, 'orders:42', { ttlMs: 5_000, fencing: true })
      const limiter = createRedisRateLimiter(ctx.ioredis, { name: 'orders', limit: 10, windowMs: 60_000 })
      const idempotency = createRedisIdempotency(ctx.ioredis, { namespace: 'orders' })
      if (!(await limiter.consume('tenant:example')).allowed) return
      const result = await idempotency.execute({ key: '42', payload: { quantity: 1 } }, () =>
        lock.withLock(({ signal, fencingToken }) => {
          signal.throwIfAborted()
          return { orderId: '42', fencingToken }
        }),
      )
      console.log(result.orderId)
    },
  }).await()
} finally {
  await app.fiber.dispose()
}
```

`tryAcquire()` 返回租约或 `undefined`，手动持有者在 `finally` 释放。续期确认耗时达到租约 TTL 时，`renew()` 返回 `false`。`withLock()` 在已确认的租约到期且续期结果未到时触发丢锁信号。限流支持固定窗口、精确滑窗和令牌桶，传入 `dryRun: true` 读取配额，`resetAt` 按调用进程的时钟换算。令牌桶在 Redis 时钟回拨后沿用原补充时间。幂等按键和请求指纹回放成功结果，执行中冲突可以配置拒绝或等待，自定义编码器需返回能无损编码为 UTF-8 的字符串。根 Fiber 关闭 Redis 连接。 [公开接口与错误](https://github.com/cevio/ainess/blob/main/packages/ioredis/README.md#租约锁限流和幂等)
