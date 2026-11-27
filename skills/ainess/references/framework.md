# @ainess/framework

在应用的 ESM 配置中默认导出 `defineApp({ plugins, entries })`，各项用 `use(plugin, options)` 包装原生 Cordis 插件。提供者、Model 和路由注册放在 `plugins`，监听器放在 `entries`。同组依赖通过 `inject` 声明。用 `app.start({ signal })` 等待就绪，可通过 `signal` 取消等待。省略 `startupTimeoutMs` 时持续等待就绪。启动取消或失败会清理已挂载的资源，关闭已启动实例用 `await running.stop()`。 [framework 手册](https://github.com/cevio/ainess/blob/main/packages/framework/README.md)

配置也可通过 `defineApp(() => ({ plugins, entries }))` 或 `defineApp(async ({ signal }) => ...)` 生成。工厂在每次启动时执行，接收可选信号，可将它传给配置 I/O。配置校验通过后开始装配，`startupTimeoutMs` 从此时计时。 [配置工厂示例](https://github.com/cevio/ainess/blob/main/packages/framework/README.md#配置工厂)

## 声明应用

宿主提供 `@ainess/framework`、`@deepseek-ai/cordis` 和示例使用的 `@ainess/http`。将以下内容保存为 `ainess.config.mjs`。框架等 HTTP 服务和路由就绪后再启动监听器。

```js
import { defineApp, use } from '@ainess/framework'
import { defineController, http, httpListener } from '@ainess/http'

export default defineApp({
  plugins: {
    http: use(http),
    health: use({
      inject: ['http'],
      apply(ctx) {
        ctx.http.route('GET', '/health', defineController(() => ({ ok: true })))
      },
    }),
  },
  entries: {
    web: use(httpListener, { host: '127.0.0.1', port: 3000 }),
  },
})
```

程序入口可将以下内容保存为 `check.mjs`。运行 `node check.mjs` 应输出 `{ ok: true }`。也可用 CLI 运行同一份配置。 [启动命令](cli.md)

```js
import app from './ainess.config.mjs'

const running = await app.start()
try {
  const address = running.ctx.http.address()
  if (!address) throw new Error('HTTP listener did not start')
  const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  console.log(await response.json())
} finally {
  await running.stop()
}
```

每次启动创建独立根 Context。安装项可以设为 `false` 以跳过，配置键用于诊断启动错误。`startupTimeoutMs` 覆盖两个阶段，超时后等待资源回收。停止时先排空入口，再释放根 Context 的提供者。重复调用同一实例的 `stop()` 会等待同一次清理。 [HTTP 监听器与 Controller 装配](http.md)
