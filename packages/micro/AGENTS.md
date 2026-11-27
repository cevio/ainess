# @ainess/micro 开发指引

公开接口、目录装配、选址行为和使用示例见[使用手册](README.md)。

- 本包负责远程服务调用、业务 RPC 连接复用和实例熔断。公开 `createMicroClient(options)`、Cordis 插件 `micro`、`MicroCircuitBreakerOptions` 及相关类型。应用传入 `MicroDiscovery`，例如 `ctx.registryClient.discovery`。插件通过 `ctx.effect()` 管理客户端并提供 `ctx.micro`，业务插件声明 `inject: ['micro']`。
- `@ainess/micro/controllers` 的 `loadMicroControllers(ctx, { directory, prefix?, extensions? })` 为业务入口生成 `readonly RpcMethod[]`。默认扫描 `*.rpc.js` 和 `*.rpc.mjs`。模块默认导出接收传入 Context 的同步工厂，返回一个由 `RpcMode` 区分的 `{ mode, handle }` 定义。Fiber 所属 Context 管理依赖和加载生命周期。入口声明工厂所需的 `inject`，将方法传入 `RpcServer.listen()`，拥有监听器与 Registry 登记的清理。
- 目录装配复用 Loader。静态段和可选前缀以点连接，省略 `(group)`，`index` 表示所在目录。导入前检查方法名、长度和本批冲突。加载器从应用调用 `loadMicroControllers()` 时检查生命周期。加载期间如果入口失去必需服务，或入口及其上层 Fiber 开始重启或卸载，用 `CANCELLED` 拒绝并跳过后续导入与工厂执行。重启检查依赖仓库固定的 Cordis 4.1 Fiber 生命周期。
- 一个客户端内，同服务的并发调用合并选址，地址按原始主机名和端口精确匹配。同地址的拨号任务与可用业务连接可以跨服务复用。业务连接按需建立，超期的握手结果按拨号失败处理。同一连接上的请求通过 RPC 的字节流控调度。调用 ID 耗尽时可为同一地址建立新的连接，旧连接在在途调用完成后回收。
- 共享选址用 `resolveTimeoutMs` 约束最多两次发现及整个连接等待过程，默认取客户端的 `timeoutMs`。第一次连接等待最多使用当时剩余预算的一半，至少 1 毫秒。失败或等待到期时，通过 `exclude` 用剩余预算最多再选一次。第二次发现或等待期间首次拨号成功时，优先复用已就绪连接并取消备用查询或等待。备用查询返回 `null`、查询拒绝或备用连接失败时，可在剩余预算内继续等待已发起的首次拨号。无效发现地址以 `INVALID_ARGUMENT` 报告。`connectTimeoutMs` 约束单次发现和每个实际拨号，包括 TCP 建连和 RPC 握手。按地址共用的拨号也受 RPC 层 10 秒时限与 Micro 客户端生命周期约束。业务 RPC 在该次调用原有时限内最多发起一次。
- 业务熔断按客户端、服务和地址记录，地址级拨号冷却可跨服务共用。按 RPC 失败来源和实际发送阶段记录可用性样本。熔断实例从连接复用和发现候选中跳过。冷却后同实例只允许一个实际业务调用试探，只以该次试探的结果判断是否恢复。
- 空闲业务连接按 `idleTimeoutMs` 回收。关闭客户端会等待所有业务 socket 完成关闭，包括已经开始关闭的连接。
- 调用者取消或单次调用超时只结束该次调用。Micro 根据取消原因转换 RPC 错误。失败观察器内触发的取消保留已确定的调用错误，包括暂停的流恢复读取时报告的错误。发现查询的取消信号通过 `pick(query, options?)` 的 `options.signal` 传给发现端，超过单次发现时限的结果会被丢弃。注入的发现对象与控制连接由应用或其提供插件管理。
- `stream()` 使用主入口导出的 `MicroStreamOptions`。`timeoutMs: false` 关闭该流的总时限，省略时沿用客户端的 `timeoutMs`。可选 `firstResponseTimeoutMs` 覆盖从首次读取到首个 `DATA` 或正常 `END` 的选址、建连与等待。可选 `readIdleTimeoutMs` 只计首响应后每次 `next()` 的等待，调用方的读取间隔及上传进度各自独立。Micro 的流式时限到期使用 `DEADLINE_EXCEEDED`，并通过 `cause.phase` 区分 `total`、`first-response` 和 `read-idle`。调用者取消使用 `CANCELLED`。Micro 将适用的发送时限通过 `openDeadline` 应用于已排队的 `OPEN`，通过 RPC 的 `beforeResponse` 在接受成功响应帧前检查读取时限。
- `onTiming` 按实际阶段报告 `MicroTimingEvent`。发现和连接等待带本次选址中的尝试序号，备用连接失败后继续等待首次拨号时可报告两次 `connect`，均为 `attempt: 2`。业务 RPC 带方法名并报告单响应结果或首次流读取。失败事件可带阶段原始错误，计时回调的异常或拒绝由 Micro 忽略。RPC 阶段报告失败后，计时回调触发的取消会保留已确定的调用错误。
- 运行时依赖 `@ainess/rpc`，目录入口使用 `@ainess/loader`。Cordis 由宿主提供，Registry 和 framework 用于集成测试。根目录运行 `pnpm --filter @ainess/micro... run build` 后执行 `node --test 'packages/micro/test/*.test.js'`。运行 `pnpm test` 还会检查测试类型和工作区集成。
