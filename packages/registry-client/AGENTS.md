# @ainess/registry-client 开发指引

公开接口和使用示例见[使用手册](README.md)。

- `RegistryClient.connect(address, options?)` 等待首次 RPC 握手。公开 `discovery.register()`、`unregister()`、`list()`、`pick()`、只读 `state` 以及幂等的 `close()`。`list()` 收齐快照，`pick()` 接受 `PickQuery`，委托 Registry 跳过本次排除地址并选择一个候选。第二参数的 `signal` 只取消该次选址，控制连接可继续使用。
- `registry` 插件在握手成功后提供 Cordis 的 `registryClient` 服务。消费者在 `inject` 中声明该键。启动取消中止拨号，已启动的插件通过 `ctx.effect()` 等待客户端关闭。
- 每个客户端拥有一条控制连接。初次连接和每次重连都将 TCP KeepAlive 的初始空闲阈值配置为 5 秒，实际探测受平台限制。按地址记录当前连接已确认的登记，并按调用顺序处理注册和注销。注册按单帧提交。注销先更新本地清单，在线时按帧大小分批发送，离线时完成本地撤销。遇到结果不确定的写入失败时关闭旧连接，只恢复仍保留的已确认登记。
- 控制连接耗尽 RPC 调用 ID 时等待已有调用结束，再关闭旧连接并恢复确认过的登记。排空期间无法发出的注销仍从恢复清单撤销。
- 当前连接断开后仅启动一个带抖动的重连任务。退避与旧 socket 的关闭并行等待，两者完成后拨号。就绪不足 5 秒再次断开时沿用退避进度，每次退避最多 5 秒。就绪持续至少 5 秒后断开时恢复初始间隔。读取恢复清单和切换就绪状态都与注册和注销按队列顺序执行。恢复期间撤销清单中的登记会关闭正在恢复的连接并中止在途恢复请求，重连时使用最新清单。连接身份隔离迟到的关闭通知，主动关闭中止拨号和退避，并等待控制 socket 关闭。
- 运行时依赖 `@ainess/rpc` 和 `@ainess/registry-shared`，Cordis 由宿主提供。`@ainess/registry-server` 与 `@ainess/framework` 用于程序集成测试。根目录 `pnpm test` 检查类型并验证真实 TCP 调用、连接两端的 KeepAlive 设置、初始化取消、服务恢复、跨包程序集成和资源清理。
