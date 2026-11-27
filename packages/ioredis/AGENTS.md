# @ainess/ioredis 开发指引

连接配置和消费示例见[使用手册](README.md)。

- `src/index.ts` 导出 Cordis 运行时插件 `ioredis`。宿主用原生 `RedisOptions` 接入单节点或 Sentinel，用 `{ startupNodes, clusterOptions? }` 接入 Redis Cluster。两种配置互斥。消费插件声明 `inject: ['ioredis']`，通过 `ctx.ioredis` 使用原生 `Redis` 或 `Cluster`。调用模式专用 API 前用 `instanceof` 缩窄类型。
- 同一个 Cordis 隔离作用域由一个 Fiber 提供 `ioredis` 服务。插件控制 `lazyConnect`，在 `ctx.effect()` 中发起 `connect()`，失败时关闭连接并回滚服务注册。Cordis 在首次连接就绪后才向消费者注入客户端，并通过 `Fiber.await()` 传播启动错误。
- 首次连接阶段暂停 `retryStrategy` 或 `clusterRetryStrategy`，就绪后恢复原生策略。启动阶段监听 Fiber 卸载，Redis Cluster 也处理发现未完成或就绪检查失败时原生 `connect()` 可能仍在等待的情况。常规卸载先等消费插件清理，再调用原生 `disconnect()` 并等待仍打开的节点命令连接关闭。启动失败或卸载后，迟到的就绪检查和槽位刷新回调触发的连接与定时器由插件再次清理。
- Cordis 和 ioredis 由宿主提供为 peer dependencies。客户端类型来自宿主所用的 ioredis 版本。工作区使用 ioredis 6.1.0 验证。与 TypeORM 1.1.3 同用时选择受双方支持的 ioredis 5。构建产物 `dist/` 是包的运行时入口和类型声明来源，也是 `pnpm pack` 的文件清单。
- ioredis 6.1.0 的公开声明引用 `redis-errors`，由本包依赖 `@types/redis-errors` 提供类型。使用 pnpm `hoist: false` 的宿主需要直接安装该类型包，以便 TypeScript 从 ioredis 的声明解析到它。
- `@ainess/ioredis/lock` 导出 `createRedisLock`，用 redlock-universal 管理租约。普通和 fencing 模式共享租约键，获取脚本用持有者识别重发并保留原租约。fencing 在同槽脚本中发号，计数器寿命独立于租约。自动续期按单调时钟排程，续期所需的最小剩余 TTL 至少为 1 毫秒，等待确认以已确认的租约期限为上限。手动续期按单调耗时校验确认。回调遵守丢锁信号，业务写入端负责比对 fencing token。
- `@ainess/ioredis/rate-limit` 导出 `createRedisRateLimiter`。固定窗口复用 redlimit。令牌桶和精确滑窗用单键脚本，分别保存补充时间和已放行记录。精确滑窗识别窗口内同一命令的重发，固定窗口和令牌桶的命令重发可能再次消耗配额。入口校验布尔值 `dryRun`，`resetAt` 按调用进程的时钟换算。
- `@ainess/ioredis/idempotency` 导出 `createRedisIdempotency`。工厂校验冲突策略及编解码方法。Quayside 负责请求指纹、TTL、结果回放及持有者校验。占位确认耗时达到租约 TTL 时跳过回调，按持有者尝试释放占位。存储层只提交能无损编码为 UTF-8 的字符串，编码错误交给 Quayside 清理占位。等待走轮询，Cluster 用单键脚本将状态读取固定在主节点。
- 三个子入口共用传入的客户端。能力按 `lock:`、`rate-limit:` 和 `idempotency:` 区分逻辑键。宿主在创建 ioredis 实例时配置 `keyPrefix`，由原生客户端应用到命令与脚本的键。能力适配层解析 Lua 整数回包，兼容原生 `stringNumbers`。连接生命周期归提供者。
- 根目录的 `pnpm test` 验证连接和能力契约。真实单节点用例需要支持 Unix socket 的 `redis-server`，集群用例还需要 `redis-cli`。集群用例启动三个主节点，检查跨槽路由、能力键前缀和关闭顺序。
