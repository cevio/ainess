# @ainess/cli 开发指引

公开命令和启动示例见[使用手册](README.md)。

- `src/cli.ts` 通过 Commander 注册 `ainess` 命令和选项，用 `parseAsync()` 等待命令完成。新增子命令在同一个 `Command` 实例上注册，根命令和子命令的帮助由声明生成。Commander 的退出码经统一出口返回。应用成功停止后沿用进程的 `process.exitCode`，退出前等待标准输出和标准错误写完。
- `ainess start [--config <file>]` 从工作目录加载 ESM 配置，默认 `ainess.config.mjs`。校验命令参数后才加载配置。配置默认导出 `defineApp()` 的结果，CLI 通过 `@ainess/framework` 的公开 `AppDefinition` 和 `RunningApp` 契约调用 `start({ signal })` 与 `stop()`。
- CLI 负责进程信号和退出。在配置加载和启动时，将 `SIGINT` 或 `SIGTERM` 转为取消。等待应用就绪期间保持进程运行。应用启动后等待停止信号，再等待 `stop()` 完成。启动期限和 Cordis 装配由框架应用配置管理。
- `@ainess/framework` 由宿主通过 peer dependency 提供。Commander 是 CLI 自身的运行依赖。HTTP 和 Cordis 的直接引用用于测试夹具。发布产物通过 `bin.ainess` 公开命令入口。
- 运行根目录的 `pnpm test`，或构建工作区后执行 `node --test packages/cli/test/cli.test.js`。测试用真实子进程验证帮助、参数、配置加载、启动等待、进程信号和输出刷新。打包时从独立应用安装 `@ainess/cli` 和 `@ainess/framework`，运行 `pnpm exec ainess start --help` 验证命令入口。
