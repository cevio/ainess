# @ainess/http-next

在 `@ainess/http` 的同一个 Node HTTP Server 上提供 Ainess API 和原生 Next.js。适配器使用 `httpListener` 的公开 `prepare` 契约。宿主提供 Next.js `^16.4.6`、React `^19.3.1`、React DOM `^19.3.1` 和需要装配的 Ainess 包。 [HTTP 监听器](../http/README.md#监听与适配器) · [Next.js Custom Server](https://nextjs.org/docs/app/guides/custom-server)

## 快速开始

应用提供 Next.js 项目。要从空目录试用，在应用根目录下创建 `web/app/layout.jsx` 和 `web/app/page.jsx`。下面分别是这两个文件的内容。

```jsx
export default function RootLayout({ children }) {
  return <html lang="en"><body>{children}</body></html>
}
```

```jsx
export default function Page() {
  return <main>Ainess and Next.js</main>
}
```

这个布局的依赖位于应用根目录。在 `web/next.config.mjs` 将 Turbopack 根目录设为应用根。使用工作区链接依赖时，根目录需要包含项目及其链接依赖。 [Turbopack 根目录](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory)

```js
import { fileURLToPath } from 'node:url'

export default {
  turbopack: { root: fileURLToPath(new URL('../', import.meta.url)) },
}
```

应用安装 `@ainess/framework`、`@ainess/cli`、`@ainess/http` 和兼容的 `@deepseek-ai/cordis`，在根目录创建 `ainess.config.mjs`。API 路由在挂载监听器前注册，`httpNext()` 直接交给 `prepare`。

```js
import { fileURLToPath } from 'node:url'
import { defineApp, use } from '@ainess/framework'
import { http, httpListener } from '@ainess/http'
import { httpNext } from '@ainess/http-next'

export default defineApp({
  plugins: {
    http: use(http),
    health: use({
      inject: ['http'],
      apply(ctx) {
        ctx.http.route('GET', '/-/health', (request) => {
          request.body = { ok: true }
        })
      },
    }),
  },
  entries: {
    web: use(httpListener, {
      host: '127.0.0.1',
      port: 3000,
      prepare: httpNext({ dir: fileURLToPath(new URL('./web/', import.meta.url)), apiPrefix: '/-' }),
    }),
  },
})
```

在应用目录运行 `NODE_ENV=development pnpm exec ainess start`。`GET http://127.0.0.1:3000/` 应得到 Next.js 页面，`GET http://127.0.0.1:3000/-/health` 应得到 `{"ok":true}`。使用原生 Cordis 时，同样可以把这个 `prepare` 传给 `ctx.plugin(httpListener, options)` 并等待监听 Fiber 就绪。 [启动命令](../cli/README.md) · [应用装配](../framework/README.md)

## 选项与分流

从 `@ainess/http-next` 导入 `httpNext(options: HttpNextOptions | HttpNextKoaFirstOptions): HttpPrepare` 及两种选项类型。

| 选项 | 行为 |
| --- | --- |
| `dir?: string` | Next.js 项目路径，默认 `process.cwd()`。应用放在子目录时传绝对路径或明确管理工作目录。 |
| `dev?: boolean` | 是否启用开发态，默认 `process.env.NODE_ENV === 'development'`。 |
| `HttpNextOptions` | `routing` 默认 `'prefix'`，`apiPrefix` 必填。API 前缀下的请求由 Ainess 处理，其余直接进入 Next.js。 |
| `HttpNextKoaFirstOptions` | `routing: 'koa-first'`，省略 `apiPrefix`，混用时立即抛出 `TypeError`。Koa 先处理，由它判断是否回退 Next.js。 |

**前缀分流**适合 API 有独立命名空间的应用。`apiPrefix` 由一个或多个以 `/` 分隔的非空路径段构成，段内可用字母、数字、下划线、连字符和 `~`，结尾省略 `/`。例如 `/-` 和 `/-/health` 进入 Ainess，`/-extra` 进入 Next.js。匹配依据是原始请求路径，忽略查询字符串。Ainess 路由注册完整路径，如 `/-/health`。此模式直接将页面流量交给 Next.js，命中前缀后的业务响应和 404 由 Ainess 负责。

**Koa 优先**适合页面和 API 共享 Koa 中间件。将 `prepare` 传为 `httpNext({ dir, routing: 'koa-first' })`，由 Koa 先处理。路由未命中、响应未被接管且原始请求流仍可转交时，才交给 Next.js。匹配路由和业务显式产生的 404 留在 Koa。把请求体解析放进匹配的 API 路由中，Next.js 的 Server Action 与 Route Handler 就能读取原始请求流。 [回退和监听契约](../http/README.md#监听与适配器)

## 开发与生产

- 适配器等待 `next.prepare()`，随后 HTTP 插件绑定端口。Next.js 管理 App Router、RSC、Server Actions、静态资源与 HMR。Next 在首次处理自己的 HTTP 请求时注册原生 Upgrade 回调，适配器通过 `PreparedHttp.onUpgrade` 转交共享监听器上未被业务协议处理器认领的连接。通过 `websocketHttp` 装配业务 WebSocket 也使用此端口。 [WebSocket 挂载](../websocket/README.md#挂载到-http)
- 准备失败时尝试关闭 Next runtime。停止应用时由 HTTP 先排空并关闭连接，再关闭 Next runtime。
- 开发编译器拥有进程级资源，应用以新进程完成开发态重启。使用 `ainess start` 时，进程收到退出信号后清理监听器与根 Fiber，再退出。程序入口先等待 `listener.dispose()` 和 `app.fiber.dispose()`，结束旧进程后由进程管理器启动新进程。
- 生产前先构建实际项目。快速开始中的 `web` 目录可在应用根运行 `pnpm exec next build web`，然后用 `NODE_ENV=production pnpm exec ainess start` 启动。
- 使用同一 Node 运行环境的 Server Component 或 Route Handler 时，可把 `getHttpRequestSignal()` 传给支持取消的调用。该入口来自 `@ainess/http/request-signal`，由共享监听器建立请求上下文。 [请求取消](../http/README.md#请求取消)

## 验证

在仓库根目录运行 `pnpm test`，或 `pnpm build` 后运行 `pnpm --filter @ainess/http-next test:integration`。真实 Next 项目验证两种分流、RSC、Server Action、请求取消、HMR 和业务 WebSocket 的同端口收发及清理，也验证开发态在新进程复用同一端口。

需要验证生产渲染时，先运行 `pnpm --filter @ainess/http-next exec next build test/fixtures/web` 构建同一夹具，再运行 `AINESS_TEST_NEXT_PRODUCTION=1 pnpm --filter @ainess/http-next test:integration`。生产模式的测试会跳过开发态重启用例。 [前缀分流测试](test/http-next.integration.js) · [Koa 优先测试](test/koa-first.integration.js) · [重启测试](test/dev-restart.integration.js)
