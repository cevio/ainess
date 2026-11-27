# @ainess/framework 开发指引

公开接口和装配示例见[使用手册](README.md)。

- `defineApp(config)` 接收 `AppConfig` 或同步、异步的 `AppConfigFactory`。对象参数在定义时校验，工厂在每次 `start({ signal })` 时求值和校验，再创建根 Context。启动中止会取消等待并丢弃迟到的工厂结果。`AppStartOptions` 提供可选的启动信号，工厂可以用它取消配置 I/O。
- `plugins` 和 `entries` 是命名的 Cordis 插件安装项，`false` 跳过该项。`use(plugin, options)` 沿用 `Context.plugin()` 的参数类型。每个安装项在传入的 Context 中挂载一个新的子 Fiber。
- 每次 `app.start({ signal? })` 创建独立的根 `Context`。先挂载整批 `plugins` 并等待激活，再挂载 `entries`。插件通过 Cordis 的 `inject` 声明依赖。`Fiber.await()` 传播启动失败，应用同时检查 Fiber 的激活状态。省略 `startupTimeoutMs` 时持续等待就绪。装配期限从配置校验完成后计时，启动信号可覆盖配置准备和装配。
- 入口共享一个子 Fiber 作为清理边界，并从根 Context 获取服务。每个入口插件拥有接收工作的时间与排空方式。所有已配置的 Fiber 激活后，`start()` 返回 `{ ctx, stop }`。启动失败、超时、取消或正常停止时，先卸载入口作用域，等待入口并发清理后再卸载根 Fiber。重复调用 `stop()` 等待同一次清理。
- 应用宿主和 [@ainess/cli](../cli/README.md) 通过公开的 `AppDefinition.start()` 与 `RunningApp.stop()` 使用同一个生命周期。配置文件加载、进程信号和退出码由调用方管理。
- 运行时依赖 Node.js 和宿主的 Cordis。HTTP、Model 和数据库只用于测试应用。根目录 `pnpm test` 检查类型推导，并通过真实 HTTP 和内存 SQLite 验证装配、多入口、启动回滚和排空。
