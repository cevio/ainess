# Ainess

Ainess 是一个基于 `@deepseek-ai/cordis` 的 TypeScript ESM monorepo。Cordis 的 `Context` 负责插件组合，`Service` 提供具名服务，`Fiber` 管理插件启动和清理。[Cordis 服务文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.md)、[生命周期文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)

## 本地验证

使用 Node.js 22.x（最低 22.13）或 24.11 及以上版本，以及 pnpm 11.22.0。

```bash
pnpm install
pnpm test
```

`pnpm test` 构建工作区、检查测试类型，并运行真实 HTTP、Next.js 与内存 SQLite 测试。本机有支持 Unix socket 的 `redis-server` 时，测试会验证 Redis 单节点的读写、重连和关闭顺序。同时装有 `redis-cli` 时，还会用三个 Redis 主节点验证集群路由。

## 接入 TypeORM

`@ainess/typeorm` 接受 TypeORM 的 `DataSourceOptions`。宿主应用安装 Cordis、TypeORM 和实际使用的数据库驱动，并传入连接选项与业务实体。示例使用 `sql.js`。[TypeORM 数据源选项](https://typeorm.io/docs/data-source/data-source-options/)

```ts
import { typeorm } from '@ainess/typeorm'
import { Context } from '@deepseek-ai/cordis'

const app = new Context()

try {
  await app.plugin(typeorm, { type: 'sqljs' }).await()
  await app.plugin({
    inject: ['typeorm'],
    apply(ctx) {
      console.log(ctx.typeorm.isInitialized)
    },
  }).await()
} finally {
  await app.fiber.dispose()
}
```

有 `inject: ['typeorm']` 的插件在连接就绪后运行，可直接使用 `ctx.typeorm.getRepository()` 和 `ctx.typeorm.transaction()`。Cordis 卸载依赖方后，再由提供者调用 `DataSource.destroy()`。[Cordis 服务注入](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.md) · [TypeORM DataSource](https://typeorm.io/docs/data-source/data-source/)

## 接入 ioredis

宿主安装 Cordis 和 ioredis。向 `@ainess/ioredis` 传入原生 `RedisOptions` 可接入单节点或 Sentinel。插件支持 ioredis 5.11.1 起的 5.x 和 ioredis 6.x，与 TypeORM 1.1.3 同用时选择 5.x。业务插件声明 `inject: ['ioredis']` 后即可通过 `ctx.ioredis` 执行 Redis 命令。

```ts
import { ioredis } from '@ainess/ioredis'
import { Context } from '@deepseek-ai/cordis'

const app = new Context()

try {
  await app.plugin(ioredis, { host: '127.0.0.1', port: 6379 }).await()
  await app.plugin({
    inject: ['ioredis'],
    async apply(ctx) {
      console.log(await ctx.ioredis.ping())
    },
  }).await()
} finally {
  await app.fiber.dispose()
}
```

Redis Cluster 通过 `startupNodes` 发现节点并路由命令，入口列表必须有至少一个节点。把读策略等集群设置放在 `clusterOptions`，把认证和 TLS 等节点连接设置放在 `clusterOptions.redisOptions`。[ioredis Cluster 文档](https://github.com/redis/ioredis/blob/v5.11.1/README.md#cluster)

```ts
await app.plugin(ioredis, {
  startupNodes: [
    { host: '127.0.0.1', port: 7000 },
    { host: '127.0.0.1', port: 7001 },
  ],
}).await()
```

集群模式仍注入 `ctx.ioredis`，使用 `nodes()` 等模式专用 API 前可用 `instanceof Cluster` 缩窄类型。`MGET` 等多键命令的键需在同一个槽位。[ioredis 集群规则](https://github.com/redis/ioredis/blob/v5.11.1/README.md#cluster)

Cordis 会等到客户端完成首次连接再激活依赖方。首次连接失败会返回给宿主，启动后的重连由 ioredis 处理。启动中卸载会取消对连接就绪的等待并断开客户端，已经启动的客户端会在依赖方清理完成后断开。[ioredis 连接事件](https://github.com/redis/ioredis/blob/v6.0.0/README.md#connection-events)

## 接入 HTTP

`http` 提供 `ctx.http`，业务插件注入后注册 Koa 中间件与路由。应用先等待业务插件加载，再安装 `httpListener`。监听就绪后可通过 `ctx.http.address()` 获取实际地址。

```ts
import { http, httpListener } from '@ainess/http'
import { Context } from '@deepseek-ai/cordis'

const app = new Context()
await app.plugin(http).await()
await app.plugin({
  inject: ['http'],
  apply(ctx) {
    ctx.http.route('GET', '/-/health', (request) => {
      request.body = { ok: true }
    })
  },
}).await()

const listener = await app.plugin(httpListener, { host: '127.0.0.1', port: 3000 }).await()
```

路由支持 `:param` 和末尾 `*`，通过 `request.params` 读取。`HEAD` 优先匹配显式路由，其次匹配同路径的 `GET`。应用退出时先 `await listener.dispose()` 等待在途响应排空，再 `await app.fiber.dispose()`。监听配置可用 `shutdownTimeoutMs` 调整排空时限，默认 30 秒。[Koa 中间件](https://koajs.com/#cascading)

### 校验并处理请求

`defineController(handle)` 直接接收处理函数，传入原始 Koa 上下文和 `{ params, query, body }`。`defineController({ schema, handle })` 使用 Standard Schema 校验一次，再把有类型的解析结果作为第二个参数。请求体由前置中间件解析，校验失败返回 `400`。handler 可返回响应体，也可以直接设置 Koa 响应并返回 `undefined`。[Standard Schema](https://standardschema.dev/)

```ts
import { defineController } from '@ainess/http'
import { z } from 'zod'

ctx.http.route('GET', '/-/items/:id', defineController({
  schema: z.object({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  handle(_request, { params }) {
    return { id: params.id }
  },
}))
```

### 按目录装配 Controller

业务插件通过 `loadHttpControllers()` 扫描 Controller 目录，在 `apply()` 中返回加载任务。工厂使用的业务服务与 `http` 一起声明在 `inject` 中。

```ts
import { loadHttpControllers } from '@ainess/http/controllers'

await app.plugin({
  inject: ['http'],
  apply(ctx) {
    return loadHttpControllers(ctx, {
      directory: new URL('./controllers/', import.meta.url),
      prefix: '/-',
    })
  },
}).await()
```

`controllers/users/[id].controller.js` 对应 `/-/users/:id`。模块默认导出接收 Cordis Context 的同步工厂。返回一个路由定义可装配单个 HTTP 方法，返回非空数组可为同一路径分别装配 GET、POST 等方法。

```ts
import { defineController } from '@ainess/http'
import type { HttpControllerModule } from '@ainess/http/controllers'

const controller: HttpControllerModule = () => ({
  method: 'GET',
  middlewares: [defineController((_request, { params }) => ({ id: params.id }))],
})

export default controller
```

`index.controller.js` 对应所在目录，`files/[...parts].controller.js` 将非空剩余路径放在 `request.params.parts`。默认扫描 `.js` 和 `.mjs`。TypeScript 项目可指向编译后的目录，宿主支持直接导入 TypeScript 时也可设置 `extensions: ['.ts']`。

分组目录只用于组织源码，`controllers/users/(staff)/[id].controller.js` 也映射到 `/-/users/:id`。HTTP 在导入 Controller 模块前校验整批路径。导入、工厂或注册失败会报告出错文件，并撤销本次已经注册的路由。卸载业务插件时，Cordis 清理其路由。

`@ainess/loader` 的 `scanModules({ directory, suffix, extensions })` 返回文件清单。`parseFileRoute(stem, { prefix, source })` 可从清单生成与运行时无关的路径段。消费包可用 `importModules(files, decode)` 导入选定文件并校验默认导出，或用 `loadModules(options, decode)` 组合扫描和导入。

### 传递请求取消信号

Koa handler 和同一 Node 运行环境中的 Next.js 服务端代码可调用 `getHttpRequestSignal()`。客户端提前断开时，监听器会中止该信号。把它传给支持取消的下游函数，例如 `fetch`。请求上下文之外返回 `undefined`。

```ts
import { getHttpRequestSignal } from '@ainess/http/request-signal'

const response = await fetch(upstreamUrl, { signal: getHttpRequestSignal() })
```

## 接入 Next.js

宿主提供 Next.js、React 和 React DOM。完成 Ainess API 路由注册后，给监听插件传入 `httpNext()`，让两边共用同一个 Node HTTP Server。

```ts
import { httpNext } from '@ainess/http-next'

const listener = await app.plugin(httpListener, {
  port: 3000,
  prepare: httpNext({
    dir: './apps/web',
    dev: process.env.NODE_ENV === 'development',
    apiPrefix: '/-',
  }),
}).await()
```

上例中 `/-` 和 `/-/` 下的请求进入 Ainess，路由注册使用完整路径，例如 `/-/health`。其余请求交给 Next.js 的原生处理函数。生产环境在 Web 项目执行 `next build`，再以生产模式启动 Cordis 入口。[Next.js custom server](https://nextjs.org/docs/app/guides/custom-server)

如果页面和 API 需要共用 Koa 中间件，可以把监听器的 `prepare` 改成 `httpNext({ dir: './apps/web', routing: 'koa-first' })`。Koa 链先处理请求。路由未命中、业务尚未接管响应且请求流仍可转交时，由 Next.js 响应。业务 404 留在 Koa。将请求体解析放到匹配的 Controller 中间件里，Next.js 的 Server Action 就能读取原始请求流。

工作区为 Next.js 16.4.6 应用开发态补丁，清理文件监视器，并让同进程重启复用原生 worker 调度器。开发编译器持有进程级句柄。开发入口在收到退出信号后，先等待 `listener.dispose()` 和 `app.fiber.dispose()`，再结束进程。
