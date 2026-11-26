# @ainess/cli

在框架应用中安装 CLI，再用 `pnpm exec ainess start` 启动。它从工作目录加载 `ainess.config.mjs`，可用 `--config <file>` 指定另一个 ESM 文件，用 `pnpm exec ainess start --help` 查看选项。配置默认导出框架应用定义。收到 `SIGINT` 或 `SIGTERM` 时，CLI 取消启动或等待已启动应用清理。生产部署使用该命令时，把 CLI 声明为应用的运行时依赖。 [CLI 手册](https://github.com/cevio/ainess/blob/main/packages/cli/README.md)

## 启动和停止

在应用根目录保存配置示例中的 `ainess.config.mjs`，安装该示例的依赖和 `@ainess/cli`。CLI 用宿主的 `@ainess/framework` 公开契约调用 `start({ signal })` 和 `stop()`。 [应用配置示例](framework.md#声明应用)

```sh
pnpm exec ainess start --help
pnpm exec ainess start
```

另开终端请求 `http://127.0.0.1:3000/health` 应得到 `{"ok":true}`。按 `Ctrl+C` 后，CLI 等待框架排空监听器并清理根服务。使用非默认文件时，例如把配置存为 `local.mjs`，运行 `pnpm exec ainess start --config ./local.mjs`。相对路径从工作目录解析，文件内的相对导入遵循 ESM 规则。

参数校验发生在加载配置之前，应用配置负责启动期限。命令参数、配置加载或应用生命周期出错时，CLI 报告错误和非零退出状态。通过进程信号正常停止时会先刷新标准输出和标准错误。
