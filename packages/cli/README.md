# @ainess/cli

提供 `ainess` 命令。CLI 用 Commander 解析参数，通过 `@ainess/framework` 的公开接口启动和停止应用。将 CLI 安装在定义应用的同一个工作区包或独立项目中。生产环境通过命令启动时，将 CLI 声明为应用的运行时依赖。

## 快速开始

应用安装 `@ainess/cli`、`@ainess/framework`、`@deepseek-ai/cordis` 和 `@ainess/http`。将框架手册中的 HTTP 配置保存为应用根目录的 `ainess.config.mjs`。用下面的命令启动，访问 `http://127.0.0.1:3000/health` 应得到 `{"ok":true}`。用 `Ctrl+C` 停止应用。 [示例配置](../framework/README.md#快速开始)

```sh
pnpm exec ainess start
```

## 命令

| 命令 | 行为 |
| --- | --- |
| `ainess --help` | 查看可用命令。 |
| `ainess start --help` 或 `ainess help start` | 查看启动选项和默认值。 |
| `ainess start [--config <file>]` | 启动配置文件声明的应用，默认读取工作目录的 `ainess.config.mjs`。 |

`--config` 接受工作目录相对路径或绝对路径，例如 `--config ./dist/ainess.config.js`。文件以 ESM 加载，默认导出 `defineApp()` 的结果。文件内的相对导入按 Node.js ESM 规则解析。文件名以 `-` 开头时，用 `--config=--local.mjs` 或 `--config ./--local.mjs` 显式传入路径。

## 等待、失败与退出

- CLI 先解析参数，再加载配置并调用应用的 `start({ signal })`。等待插件和入口就绪时，CLI 保持进程运行。启动期限由应用配置中的 `startupTimeoutMs` 控制，省略时持续等待就绪。 [应用装配与启动配置](../framework/README.md)
- 收到 `SIGINT` 或 `SIGTERM` 时，CLI 结束配置加载的等待或取消正在进行的启动。应用就绪后收到信号时，CLI 等待 `running.stop()` 完成。成功处理信号后，CLI 等待标准输出和标准错误写完，使用应用设置的 `process.exitCode` 退出，默认状态码为 `0`。开发态 Next.js 在新进程中重新启动。 [Next.js 重启](../http-next/README.md#开发与生产)
- 未知命令、未知选项和缺失的选项值会报错。配置模块在进程空闲时仍未完成求值，CLI 会报告加载失败。配置加载、`start()` 或 `stop()` 将错误传给 CLI 时，CLI 输出错误并以非零状态退出。

## 验证

在仓库根目录运行 `pnpm test`，或执行 `pnpm build` 后运行 `node --test packages/cli/test/cli.test.js`。测试用真实子进程验证命令帮助、参数检查、配置加载、启动等待、信号清理和输出刷新。 [CLI 测试](test/cli.test.js)
