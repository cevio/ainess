# @ainess/micro 开发指引

公开接口、选址行为和使用示例见[使用手册](README.md)。

- 本包负责远程服务调用、业务 RPC 连接复用和实例熔断。公开 `createMicroClient(options)`、Cordis 插件 `micro`、`MicroCircuitBreakerOptions` 及相关类型。应用传入 `MicroDiscovery`，例如 `ctx.registryClient.discovery`。插件通过 `ctx.effect()` 管理客户端并提供 `ctx.micro`，业务插件声明 `inject: ['micro']`。
- 一个客户端内，同服务的并发调用合并选址，地址按原始主机名和端口精确匹配。同地址的拨号任务与可用业务连接可以跨服务复用。业务连接按需建立，同一连接上的请求通过 RPC 的字节流控调度。调用 ID 耗尽时可为同一地址建立新的连接，旧连接在在途调用完成后回收。
- 业务拨号失败时，合并后的选址任务通过 `exclude` 最多再选一次。排除和地址冷却仅影响当前客户端的选址。业务请求发出后的执行结果和错误直接返回给调用方。
- 业务熔断按客户端、服务和地址记录，地址级拨号冷却可跨服务共用。按 RPC 失败来源和实际发送阶段记录可用性样本。熔断实例从连接复用和发现候选中跳过。冷却后同实例只允许一个实际业务调用试探，只以该次试探的结果判断是否恢复。
- 空闲业务连接按 `idleTimeoutMs` 回收。关闭客户端会等待所有业务 socket 完成关闭，包括已经开始关闭的连接。
- 调用者取消只结束该次调用。Micro 根据取消原因转换 RPC 错误，保留已收到的业务错误。共享选址有独立时限，取消信号通过 `pick(query, options?)` 的 `options.signal` 传给发现端。共享选址到期或客户端关闭时，Micro 主动结束等待。注入的发现对象与控制连接由应用或其提供插件管理。
- 运行时依赖 `@ainess/rpc`。Cordis 由宿主提供，Registry 和 framework 用于集成测试。根目录运行 `pnpm --filter @ainess/micro... run build` 后执行 `node --test 'packages/micro/test/*.test.js'`。运行 `pnpm test` 还会检查测试类型和工作区集成。
