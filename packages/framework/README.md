# @ainess/framework

用 `defineApp()` 装配一个 Cordis 应用。把数据库、注册器、业务插件和路由放在 `plugins`，把监听器等开始接收工作的插件放在 `entries`。宿主应用依赖 `@ainess/framework` 和兼容的 `@deepseek-ai/cordis`。下例还使用 [`@ainess/http`](../http/README.md)。

## 快速开始

在应用根目录保存 `ainess.config.mjs`。这里先注册路由，再在 `127.0.0.1:3000` 开始接收请求。

```js
import { defineApp, use } from '@ainess/framework'
import { http, httpListener } from '@ainess/http'

export default defineApp({
  plugins: {
    http: use(http),
    health: use({
      inject: ['http'],
      apply(ctx) {
        ctx.http.route('GET', '/health', (request) => {
          request.body = { ok: true }
        })
      },
    }),
  },
  entries: {
    web: use(httpListener, { host: '127.0.0.1', port: 3000 }),
  },
})
```

将以下内容保存为 `check.mjs`，运行 `node check.mjs` 应输出 `{ ok: true }`。程序通过公开接口控制应用启动和清理。

```js
import app from './ainess.config.mjs'

const running = await app.start()
try {
  const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(5_000) })
  console.log(await response.json())
} finally {
  await running.stop()
}
```

从命令行运行这份配置时，使用 [@ainess/cli](../cli/README.md)。

## 配置工厂

配置可以由同步或异步函数返回。同步函数适合在每次启动时重新读取环境变量。异步函数可以先读取配置文件，再返回插件和入口的配置。

在应用目录创建内容为 `3000` 的 `port.txt`。以下配置可保存为 `ainess.config.mjs`，通过 `ainess start` 启动。

```js
import { readFile } from 'node:fs/promises'
import { defineApp, use } from '@ainess/framework'
import { http, httpListener } from '@ainess/http'

export default defineApp(async ({ signal }) => {
  const port = Number(await readFile(new URL('./port.txt', import.meta.url), { encoding: 'utf8', signal }))
  return {
    plugins: { http: use(http) },
    entries: { web: use(httpListener, { host: '127.0.0.1', port }) },
  }
})
```

`start({ signal })` 在调用时执行工厂一次，接收该次启动的可选 `signal`。异步工厂会等待结果返回，再按现有规则校验配置。工厂抛错或返回非法值会让 `start()` 拒绝。启动中止会取消等待并丢弃随后返回的配置。将 `signal` 传给工厂内的 I/O 可以同时取消该操作。工厂返回的 `startupTimeoutMs` 从配置校验通过后开始计时，覆盖 `plugins` 和 `entries` 的装配。需要为配置准备和装配设置同一个期限时，可以调用 `app.start({ signal: AbortSignal.timeout(5_000) })`。

## 公开接口

从 `@ainess/framework` 导入以下接口和类型。

| 接口 | 契约 |
| --- | --- |
| `defineApp(config: AppConfig \| AppConfigFactory): AppDefinition` | 返回可启动的定义。对象参数在定义时检查，工厂返回的配置在每次启动时检查。 |
| `AppConfigFactory`、`AppStartOptions` | 工厂接收只读的启动选项，返回 `AppConfig` 或 `PromiseLike<AppConfig>`。启动选项可传 `signal`。 |
| `use(plugin, options?)` | 将原生 `Context.plugin()` 的参数转成 `PluginEntry`，插件的配置类型保留在调用处。 |
| `PluginEntry` | `mount(ctx): Fiber` 把插件挂载到传入的 Context。自定义安装项每次须返回该 Context 下新挂载的直接子 Fiber。 |
| `AppDefinition.start({ signal }?)` | 等待应用就绪，返回 `Promise<RunningApp>`。`signal` 可取消启动。 |
| `RunningApp` | `ctx` 是本次运行的根 Context，`stop(): Promise<void>` 等待入口和根作用域清理。 |

`AppConfig` 接受三个可选字段。

| 字段 | 用法 |
| --- | --- |
| `plugins` | 按名称声明前置插件。整组挂载后等待该组全部激活。 |
| `entries` | 按名称声明入口插件。前置插件就绪后挂载，所有入口就绪后 `start()` 返回。 |
| `startupTimeoutMs` | 可选的启动期限，单位毫秒，接受 `1` 到 `2_147_483_647` 的整数，覆盖两个装配阶段。省略时持续等待就绪。 |

两组都接受普通对象，省略时为空组。单项值为 `use(...)` 的返回值或 `false`。名称用于启动诊断，服务键由提供者定义。用 Cordis 的 `inject` 表达依赖，同组插件可以先于其依赖的提供者出现在配置中。`plugins` 所需的服务在 `plugins` 组内完成装配，`entries` 可消费这些服务。

## 就绪、失败与停止

- 每次 `start()` 都创建独立根 Context，同一份定义可以重新启动。固定端口和外部资源由对应插件管理，重复启动前需处理这些资源的占用。
- 应用同时检查 Cordis 的启动任务和 Fiber 的激活状态。等待期间出现插件错误会带上 `plugins.<name>` 或 `entries.<name>`，超时会列出仍在等待的安装项和可识别的缺失服务。`start({ signal })` 使用信号原因拒绝已取消的启动，启动成功后的关闭用 `stop()`。
- 入口共享一个清理作用域，入口插件拥有接收及排空工作的逻辑。停止或启动失败时，应用先等待入口清理，再释放根 Context。启动超时开始回收，最终返回仍需等待清理。启动错误与 Fiber 卸载传出的错误同时出现时，`start()` 返回包含两者的 `AggregateError`。Cordis 在卸载内部捕获的清理错误通过日志服务记录，程序入口可查看 `running.ctx.logger.buffer`。
- 对同一 `RunningApp` 重复调用 `stop()` 会等待同一次清理。把连接、定时器和其他外部资源归还给创建它们的插件，用 `ctx.effect()` 注册清理。入口的排空过程可继续使用前置插件提供的数据库等服务。 [Cordis 生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)

## 验证

在仓库根目录运行 `pnpm test`，或执行 `pnpm build` 后运行 `node --test packages/framework/test/framework.test.js`。应用装配测试覆盖配置工厂、真实 HTTP 和内存 SQLite、多入口排空及启动回滚。类型用例随根测试检查。 [装配测试](test/framework.test.js) · [类型用例](test/types.ts)
