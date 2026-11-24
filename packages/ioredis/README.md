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

## 验证

在仓库根目录运行 `pnpm test`，或运行 `pnpm build` 后执行 `node --test packages/ioredis/test/*.test.js`。真实单节点用例需要支持 Unix socket 的 `redis-server`，集群用例还需要 `redis-cli`，会在本机创建三个主节点。测试覆盖连接失败、卸载期间的发现和刷新、真实读写和重连。 [单节点测试](test/ioredis.test.js) · [集群测试](test/cluster.test.js)
