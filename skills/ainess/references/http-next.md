# @ainess/http-next

用 `httpNext(options)` 生成 `httpListener` 的 `prepare`。宿主提供 Next.js、React 和 React DOM。前缀分流时设置 `apiPrefix`，Ainess 按完整 API 路径注册路由，其他路径直接进入 Next.js。页面需要共享 Koa 中间件时，用 `routing: 'koa-first'` 并省略 `apiPrefix`。只有路由未命中、响应尚未被接管且请求流仍可转交时才进入 Next.js。请求体解析放在匹配的 API 路由内。 [Next.js 手册](https://github.com/cevio/ainess/blob/main/packages/http-next/README.md)

## 加入 Next.js

示例需要 `@ainess/http-next`、`@ainess/http`、`@ainess/framework`、`@ainess/cli`、`@deepseek-ai/cordis` 和兼容的 Next.js、React、React DOM。已有应用可在现有 `httpListener` 的选项中使用同样的 `prepare`，并把 `dir` 改为实际 Next.js 项目路径。

将布局保存为 `web/app/layout.jsx`。

```jsx
export default function Layout({ children }) {
  return <html lang="en"><body>{children}</body></html>
}
```

将页面保存为 `web/app/page.jsx`。

```jsx
export default function Page() {
  return <main>Ainess and Next.js</main>
}
```

依赖装在应用根目录时，为 `web/next.config.mjs` 声明编译根。使用工作区链接依赖时，编译根也需覆盖链接依赖。

```js
import { fileURLToPath } from 'node:url'

export default {
  turbopack: { root: fileURLToPath(new URL('../', import.meta.url)) },
}
```

将配置保存为 `ainess.config.mjs`。先注册完整的 `/api/health` 路径，再启动共享监听器。

```js
import { fileURLToPath } from 'node:url'
import { defineApp, use } from '@ainess/framework'
import { defineController, http, httpListener } from '@ainess/http'
import { httpNext } from '@ainess/http-next'

export default defineApp({
  plugins: {
    http: use(http),
    health: use({
      inject: ['http'],
      apply(ctx) {
        ctx.http.route('GET', '/api/health', defineController(() => ({ ok: true })))
      },
    }),
  },
  entries: {
    web: use(httpListener, {
      host: '127.0.0.1',
      port: 3000,
      prepare: httpNext({ dir: fileURLToPath(new URL('./web/', import.meta.url)), apiPrefix: '/api' }),
    }),
  },
})
```

开发态运行 `NODE_ENV=development pnpm exec ainess start`。请求 `http://127.0.0.1:3000/api/health` 应得到 `{"ok":true}`，请求同端口的 `/` 应看到 `Ainess and Next.js`。验证已有 HTTP 应用时，可以保留原有 `/api` 路由。 [HTTP、Model 和 TypeORM](http.md#运行-httpmodel-和-typeorm)

生产先运行 `pnpm exec next build web`，再运行 `NODE_ENV=production pnpm exec ainess start`。关闭时 HTTP 监听器先排空，再关闭 Next runtime。开发态重启时，等待旧进程完成清理后启动新进程。Node 运行时的 Server Component 和 Route Handler 可从 `@ainess/http/request-signal` 导入 `getHttpRequestSignal()`，将断开信号传给下游。 [CLI 启停](cli.md) · [Turbopack 根目录](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory)
