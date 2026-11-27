# @ainess/ioredis

把原生 ioredis `Redis` 或 `Cluster` 注册为 Cordis 的 `ioredis` 服务。宿主依赖 `@ainess/ioredis`、工作区所用的 `@deepseek-ai/cordis` 以及 ioredis `^5.11.1` 或 `^6.0.0`。需要兼容 TypeORM 1.1.3 的 ioredis peer 时，选择 ioredis 5.x。

ioredis 6.1.0 的类型声明引用 `redis-errors`，本包依赖 `@types/redis-errors` 提供类型。使用 pnpm `hoist: false` 的 TypeScript 应用还要在宿主直接运行 `pnpm add -D @types/redis-errors`。

## 快速开始

在本机有 Redis 监听 `127.0.0.1:6379` 时，把以下内容保存为 `ping.mjs`，运行 `node ping.mjs` 应输出 `PONG`。应用配置也可在 `plugins` 组写 `use(ioredis, options)`。 [应用装配](../framework/README.md)

```js
import { ioredis } from '@ainess/ioredis'
import { Context } from '@deepseek-ai/cordis'

const app = new Context()
try {
  await app.plugin(ioredis, { host: '127.0.0.1', port: 6379 }).await()
  await app.plugin({
    inject: ['ioredis'],
    async apply(ctx) {
      console.log(await ctx.ioredis.ping())
    },
  }).await()
} finally {
  await app.fiber.dispose()
}
```

## 连接选项

从 `@ainess/ioredis` 导入插件 `ioredis` 和类型 `IoredisOptions`。安装时选一种配置形态。

| 模式 | 传给 `ctx.plugin(ioredis, options)` 的配置 |
| --- | --- |
| 单节点或 Sentinel | 原生 `RedisOptions`。省略配置时使用原生单节点默认值。Sentinel 使用 `sentinels` 和 `name` 等原生字段。 |
| Redis Cluster | `{ startupNodes, clusterOptions? }`。`startupNodes` 至少提供一个种子节点。集群路由策略放入 `clusterOptions`，节点认证和 TLS 等配置放入 `clusterOptions.redisOptions`。 |

集群示例可替换上面的提供者安装语句。客户端从种子节点发现拓扑。

```js
await app.plugin(ioredis, {
  startupNodes: [
    { host: '127.0.0.1', port: 7000 },
    { host: '127.0.0.1', port: 7001 },
  ],
}).await()
```

集群和单节点的顶层选项互斥。缺少 `startupNodes` 或在集群配置中混入单节点选项会导致启动错误。客户端仍来自 `ctx.ioredis`，调用 `nodes()` 等集群专用 API 时，从宿主的 `ioredis` 导入 `Cluster` 并用 `instanceof Cluster` 缩窄类型。`MGET` 等集群多键命令要求相关键位于同一槽位，可用一致的 hash tag 安排需要一起操作的键。 [ioredis Sentinel](https://github.com/redis/ioredis/blob/v5.11.1/README.md#sentinel) · [ioredis Cluster](https://github.com/redis/ioredis/blob/v5.11.1/README.md#cluster)

## 就绪与清理

- 在同一 Cordis 隔离作用域内由一个 Fiber 提供 `ioredis`。消费插件声明 `inject: ['ioredis']` 并复用客户端执行命令，避免按请求创建连接。需要订阅或长期阻塞命令时，为它们使用专用连接，并由创建者负责清理。 [ioredis Pub/Sub](https://github.com/redis/ioredis/blob/v5.11.1/README.md#pubsub)
- 插件设置 `lazyConnect: true` 后主动调用 `connect()`，首次连接成功后消费者才激活。启动期间暂停客户端的 `retryStrategy` 或 `clusterRetryStrategy`，首次失败通过 `Fiber.await()` 报告，失败的连接和服务注册由提供者回收。
- 首次连接结束后恢复原生重连策略。应用在重连期间按 ioredis 的命令队列、超时和失败策略处理中途断线。服务的初次激活与之后单条命令的成功是两个独立条件。 [ioredis 重连与连接事件](https://github.com/redis/ioredis/blob/v6.1.0/README.md#auto-reconnect)
- 卸载时依赖方先清理，提供者再断开客户端、等待命令连接关闭。启动中卸载也会停止等待并清理连接，集群的迟到就绪和槽位刷新也由插件处理。消费者通过 Fiber 或应用的 `stop()` 触发托管连接清理。

## 租约锁、限流和幂等

三个子入口接收原生 `ctx.ioredis`，共用一个命令客户端。宿主用单节点或 Sentinel 的 `keyPrefix`，或 Cluster 的 `clusterOptions.keyPrefix`，一次配置所有命令的前缀。键形如 `<keyPrefix>lock:…`、`<keyPrefix>rate-limit:…` 或 `<keyPrefix>idempotency:…`。ioredis 添加客户端前缀一次。Cluster 下使用 `app:` 这类不带花括号的前缀，避免干扰多键脚本用来保持同槽的 hash tag。

启用原生 `stringNumbers: true` 时，三个能力按各自接口返回值，原生命令按 ioredis 配置返回字符串形式的整数。Cluster 将该选项放在 `clusterOptions.redisOptions` 中。ioredis 5.11.1 启用此选项后可能漏载槽位，`enableAutoPipelining` 会在访问缺失的槽位时报错。该配置组合已用 ioredis 6.1.0 验证。

### 租约锁

从 `@ainess/ioredis/lock` 导入 `createRedisLock(redis, key, options)`。`key` 是非空资源键，`ttlMs` 是租约时长。开启 `fencing: true` 后，租约键与计数器同槽，加锁时原子递增计数器。返回的 `fencingToken` 是十进制字符串，计数器的生命周期独立于租约。严格的业务写入由下游按数值大小原子比较 token。Redis 异步复制发生故障转移时，已确认的锁与计数器写入都可能丢失。 [redlock-universal](https://github.com/alexpota/redlock-universal) · [Redis 分布式锁](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)

- `tryAcquire()` 只尝试获取一次，锁被占用时返回 `undefined`，Redis 错误抛出。手动持有的租约可用 `renew()` 续期，并在 `finally` 调用 `release()`。两者返回是否仍匹配持有者。续期确认耗时达到 `ttlMs` 时，`renew()` 返回 `false`。
- `withLock(async ({ signal, fencingToken }) => ...)` 用单调时钟安排续期，并在回调结束后释放。自动续期所需的最小剩余 TTL 至少为 1 毫秒。默认额外重试次数 `retryAttempts` 为 `0`，`retryDelayMs` 为 `100`。取锁失败抛出 `LockAcquisitionError`。续期失败或已确认的租约到期时仍未收到续期确认，都会触发 `signal`。回调成功后，如果续期已失败或释放返回持有者不匹配，则抛出 `RedisLockOwnershipLostError`。续期失败的原因可从 `cause` 读取。释放成功的响应丢失后，客户端重发也可能收到持有者不匹配的结果。
- ioredis 重发同一获取命令时，仍有效的租约沿用原有效期和 fencing token。

### 限流

从 `@ainess/ioredis/rate-limit` 导入 `createRedisRateLimiter(redis, options)`。用非空 `name` 标识策略，用正整数 `limit` 设置预算。默认 `fixed-window` 复用 redlimit，按 Redis 时间对齐窗口。`sliding-window` 逐个记录已放行的请求，两者均要求 `windowMs`。设置 `algorithm: 'token-bucket'` 时，`limit` 是容量，`refill: { amount, intervalMs }` 是补充速度。Redis 时钟回拨时，令牌桶可消耗已有余额，补充与过期继续按原补充时间计算。同名同算法的策略共享预算，使用方应采用一致的参数。 [redlimit](https://github.com/iruizsalinas/redlimit) · [Redis 限流算法](https://redis.io/docs/latest/develop/use-cases/rate-limiter/nodejs/)

`consume(subject)` 为每次放行原子扣减一个单位。`consume(subject, { dryRun: true })` 查看当前预算。`dryRun` 接受布尔值，省略时为 `false`。结果包含 `allowed`、`limit`、`remaining`、Unix 毫秒时间 `resetAt` 和拒绝后的 `retryAfterMs`。`resetAt` 由 Redis 上的剩余时长换算到应用时钟。拒绝时它表示下次可尝试获取额度的时刻。放行时它表示固定窗口结束、滑窗最早命中过期或令牌桶补满的时刻。Redis 错误直接抛出。

如果 Redis 已成功扣减配额，ioredis 因响应丢失而重发命令，固定窗口和令牌桶会再次尝试扣减。精确滑窗会识别仍在窗口内的同一命令重发，保留原有放行记录。

### 幂等

从 `@ainess/ioredis/idempotency` 导入 `createRedisIdempotency(redis, options?)`，然后调用 `execute({ key, payload }, handler)`。同键同指纹回放成功结果，同键不同指纹抛出 `IdempotencyKeyReuseError`，回调失败后可以重新尝试。默认 `namespace` 为 `default`，`lockTtl` 为 30 秒，`resultTtl` 为 24 小时。时长接受毫秒或 `'30s'` 这类字符串。结果默认使用 JSON 编码，也可以传入 `codec: { encode, decode }`。 [Quayside](https://github.com/pinceladasdaweb/quayside)

执行中的重复调用默认抛出 `ConcurrentExecutionError`。`onConflict` 支持 `reject` 和 `wait`，自定义 `codec` 必须同时提供 `encode` 和 `decode` 方法。工厂收到非法策略或编解码配置时抛出 `TypeError`。`encode()` 的结果必须能无损编码为 UTF-8 字符串，违反该约束会抛出 `SerializationError` 并尝试释放占位。设置 `onConflict: 'wait'` 后，`waitTimeout` 是轮询预算，默认为 10 秒。预算耗尽且仍在等待时抛出 `WaitTimeoutError`。已发出的 Redis 命令受客户端的命令超时设置约束，读到完成记录时可回放结果。

占位确认耗时达到 `lockTtl` 时，按持有者尝试释放本次占位，并在进入回调前抛出 `FencingError`。遇到 Redis 连接故障时，未能释放的占位由 TTL 回收。长任务可以调用回调参数的 `extend()`，旧执行者在租约过期后提交结果也会收到 `FencingError`。提交命令重发时，工厂根据主节点上同一持有者的已存结果确认完成。Redis 存储故障通过调用错误报告，数据库或外部服务的副作用由写入端按业务幂等键保护。

工厂返回 Quayside 的 `Idempotency` 实例。`executeWithMetadata()` 可读取是否回放和记录时间，`get()` 可查询占位和结果，`wrap()` 可包装函数。`invalidate()` 会删除当前记录，允许下一次调用重新获取占位。

### 装配示例

本机启动 Redis 后，将以下示例保存为 `redis-primitives.mjs`。运行 `node redis-primitives.mjs` 应输出 `42`。

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
      const lock = createRedisLock(ctx.ioredis, 'sales:order:42', { ttlMs: 5_000, fencing: true })
      const limiter = createRedisRateLimiter(ctx.ioredis, { name: 'sales.create-order', limit: 30, windowMs: 60_000 })
      const idempotency = createRedisIdempotency(ctx.ioredis, { namespace: 'sales' })
      const quota = await limiter.consume('tenant:example')
      if (!quota.allowed) throw new Error(`Retry after ${quota.retryAfterMs} ms`)

      const input = { orderId: '42', quantity: 1 }
      const result = await idempotency.execute({ key: input.orderId, payload: input }, () =>
        lock.withLock(({ signal, fencingToken }) => {
          signal.throwIfAborted()
          return { orderId: input.orderId, fencingToken }
        }),
      )
      console.log(result.orderId)
    },
  }).await()
} finally {
  await app.fiber.dispose()
}
```

## 验证

在仓库根目录运行 `pnpm test`，或运行 `pnpm build` 后执行 `node --test packages/ioredis/test/*.test.js`。真实单节点用例需要支持 Unix socket 的 `redis-server`，集群用例还需要 `redis-cli`，会在本机创建三个主节点。用例覆盖连接生命周期、租约竞争和获取命令重发、配额并发、幂等占位超时与结果回放，并验证 `stringNumbers` 回包和 Cluster 客户端前缀。 [单节点测试](test/ioredis.test.js) · [集群测试](test/cluster.test.js)
