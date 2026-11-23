# @ainess/ioredis 开发指引

- `src/index.ts` 导出 Cordis 运行时插件 `ioredis`。宿主用原生 `RedisOptions` 接入单节点或 Sentinel，用 `{ startupNodes, clusterOptions? }` 接入 Redis Cluster。两种配置互斥。消费插件声明 `inject: ['ioredis']`，通过 `ctx.ioredis` 使用原生 `Redis` 或 `Cluster`。调用模式专用 API 前用 `instanceof` 缩窄类型。
- 同一个 Cordis 隔离作用域由一个 Fiber 提供 `ioredis` 服务。插件控制 `lazyConnect`，在 `ctx.effect()` 中发起 `connect()`，失败时关闭连接并回滚服务注册。Cordis 在首次连接就绪后才向消费者注入客户端，并通过 `Fiber.await()` 传播启动错误。
- 首次连接阶段暂停 `retryStrategy` 或 `clusterRetryStrategy`，就绪后恢复原生策略。启动阶段监听 Fiber 卸载，Redis Cluster 也处理发现未完成或就绪检查失败时原生 `connect()` 可能仍在等待的情况。常规卸载先等消费插件清理，再调用原生 `disconnect()` 并等待仍打开的节点命令连接关闭。启动失败或卸载后，迟到的就绪检查和槽位刷新回调触发的连接与定时器由插件再次清理。
- Cordis 和 ioredis 由宿主提供为 peer dependencies。客户端类型来自宿主所用的 ioredis 版本。工作区使用 ioredis 6 验证。与 TypeORM 1.1.3 同用时选择受双方支持的 ioredis 5。构建产物 `dist/` 是包的运行时入口和类型声明来源，也是 `pnpm pack` 的文件清单。
- 根目录的 `pnpm test` 验证配置互斥、启动失败回滚和卸载时的就绪检查与槽位刷新。本机有可用的 `redis-server` 和 Unix socket 时，单节点用例验证读写和重连。有 `redis-server` 和 `redis-cli` 时，集群用例会启动本机三个主节点验证跨槽路由与关闭顺序。
