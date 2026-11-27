# @ainess/http

提供 Cordis 的 `http` 服务和 HTTP 监听入口。业务插件使用 Koa 中间件和路由，宿主决定何时监听。单个或动态路由可用 `ctx.http.route()`，按文件维护的 Controller 可一次装配整个目录。宿主提供工作区所用的 `@deepseek-ai/cordis`，本包提供 Koa、find-my-way 和目录加载依赖。

## 快速开始

保存为 `health.mjs` 后运行 `node health.mjs`。程序注册路由后使用空闲端口监听，发出真实请求，再排空监听器和根 Fiber。

```js
import assert from 'node:assert/strict'
import { defineController, http, httpListener } from '@ainess/http'
import { Context } from '@deepseek-ai/cordis'

const app = new Context()
try {
  await app.plugin(http).await()
  await app.plugin({
    inject: ['http'],
    apply(ctx) {
      ctx.http.route('GET', '/health', defineController(() => ({ ok: true })))
    },
  }).await()

  const listener = app.plugin(httpListener, { host: '127.0.0.1', port: 0 })
  try {
    await listener.await()
    const address = app.http.address()
    assert.ok(address)
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    assert.equal(response.status, 200)
    console.log(await response.json())
  } finally {
    await listener.dispose()
  }
} finally {
  await app.fiber.dispose()
}
```

框架应用可把 `http` 和路由插件放在 `plugins`，把 `httpListener` 放在 `entries`。独立使用 Cordis 时，宿主负责等待路由装配和监听完成。 [跨包装配示例](../../README.md#通过配置启动)

## 路由和 Controller

从 `@ainess/http` 导入 `http`、`httpListener`、`defineController` 以及以下类型。

| 接口或类型 | 契约 |
| --- | --- |
| `http` 和 `HttpOptions` | `ctx.plugin(http, options?)` 安装服务。`koa` 可传 Koa 构造选项。`router` 可设置 `caseSensitive`、`ignoreTrailingSlash`、`ignoreDuplicateSlashes` 和 `maxParamLength`，省略时沿用底层默认值。 |
| `HttpService` | 消费插件声明 `inject: ['http']` 后，通过 `ctx.http` 使用 `use()`、`route()`、`address()` 和 `registerUpgrade()`。 |
| `HttpMethod` 和 `HttpRouteMiddleware` | 使用 find-my-way 的 HTTP 方法类型和带 `params: Record<string, string \| undefined>` 的 Koa 路由中间件类型。 |
| `ctx.http.use(middleware)` | 注册全局 Koa 中间件，返回 `void`。用 `await next()` 进入后续中间件和路由。随调用方 Fiber 清理。 |
| `ctx.http.route(method, path, ...middlewares)` | 路径以 `/` 开头，使用单个方法和至少一个中间件，返回可调用的撤销函数。路由随调用方 Fiber 清理，也可主动调用该函数撤销。 |
| `ctx.http.address()` | 返回实际监听地址 `AddressInfo`，尚未监听或监听关闭时返回 `null`。 |

显式路由支持 `:param` 和末尾 `*`，分别从 `request.params.param` 和 `request.params['*']` 读取。注册路径使用路径部分，`?` 和 `#` 会被拒绝。`HEAD` 优先匹配显式路由，然后查找同路径的 `GET`。路由冲突在注册时报告。为全站共享的能力使用 `use()`，为只处理某些请求的校验、鉴权或请求体解析使用对应路由的中间件。 [Koa 中间件](https://koajs.com/#cascading)

`defineController()` 返回 `HttpRouteMiddleware`，创建时校验处理函数和可选 Schema 的调用形态。处理函数可以同步或异步。支持以下形态。

| 形态 | `handle(request, input)` 的 `input` |
| --- | --- |
| `defineController(handle)` 或 `defineController({ handle })` | `HttpControllerInput`，即 `{ params, query, body }`。 |
| `defineController({ schema, handle })` | `HttpControllerOptions<Input>` 接受 Standard Schema。校验一次并将解析后的 `Input` 传入，失败时抛出带 `issues` 的 `400 Invalid request`。 |

第一个参数始终是原始 Koa Context。`body` 来自前置中间件写入的 `request.request.body`，没有解析时为 `undefined`。处理函数返回的非 `undefined` 值成为响应体，返回 `undefined` 时保留它设置的 Koa 响应。可用共享错误中间件处理校验异常。已有 Schema 时直接传入，避免重复解析同一份请求输入。 [Standard Schema](https://standardschema.dev/)

## 按目录装配 Controller

创建 `controllers/users/[id].controller.mjs`，默认导出同步工厂。工厂接收装配插件的 Cordis Context，返回一个 `HttpControllerDefinition` 或非空数组。每个定义提供一个 `method` 和非空 `middlewares` 列表。同一路径的多个方法可以由一个工厂声明。

```js
import { defineController } from '@ainess/http'

/** @type {import('@ainess/http/controllers').HttpControllerModule} */
const controller = () => ({
  method: 'GET',
  middlewares: [defineController((_request, { params }) => ({ id: params.id }))],
})

export default controller
```

以 `httpControllers()` 替换快速开始中的路由插件，发起 `GET /api/users/42` 即可取得 `{"id":"42"}`。

```js
import { httpControllers } from '@ainess/http/controllers'

await app.plugin(httpControllers({
  directory: new URL('./controllers/', import.meta.url),
  prefix: '/api',
})).await()
```

| `@ainess/http/controllers` 接口 | 用法 |
| --- | --- |
| `httpControllers(options: HttpControllerDirectoryOptions)` | 返回 Cordis 插件，自动注入 `http`。用 `options.inject` 的非空服务名字符串数组声明工厂所需的其他服务，默认 `[]`。创建插件时验证列表。 |
| `loadHttpControllers(ctx, options: HttpControllersOptions): Promise<void>` | 在已有插件的 `apply()` 中返回或等待此任务。该插件同时声明 `http` 和工厂所需服务。 |
| `HttpControllerModule`、`HttpControllerDefinition` | 为模块默认工厂和单条方法定义提供类型。 |

两种入口均支持 `directory`（路径或 `file:` URL）、`extensions`（默认 `['.js', '.mjs']`）和 `prefix`（默认空）。默认匹配 `*.controller.js` 和 `*.controller.mjs`。TypeScript 应用通常扫描编译目录，宿主可直接导入 TypeScript 时可显式配置 `extensions: ['.ts']`。

| 以 `/api` 为前缀的文件 | URL 与参数 |
| --- | --- |
| `index.controller.js` | `/api` |
| `users/(staff)/[id].controller.js` | `/api/users/:id`，`request.params.id` 是路径参数。 |
| `files/[...parts].controller.js` | `/api/files/*`，`request.params.parts` 是非空剩余路径字符串。 |

如果更具体的文件通配路由没有剩余路径，继续按同一 HTTP 方法寻找匹配。例如同时声明 `files/[...parts]` 和 `files/images/[...images]` 时，`/api/files/images/` 由前者处理。相同方法和路由模式的显式通配与文件通配会报告注册冲突。

装配先检查整批文件路径，再导入、调用同步工厂并注册。失败时报告来源文件，注册冲突回滚本批路由。路由归调用方 Fiber 所有。导入或执行工厂期间若作用域被卸载或必需服务被撤销，等待当前步骤结束并跳过后续模块导入、剩余工厂及本批注册。工厂负责同步组装路由，连接和资源初始化交给已有的业务插件。 [文件路由语法](../loader/README.md#文件路由)

## 监听与适配器

每个 `http` 服务可挂载一个 `httpListener`。`Fiber.await()` 等待绑定成功，启动失败会清理已准备好的适配器。监听通过 `HttpListenerOptions` 配置。

| 字段 | 契约 |
| --- | --- |
| `port` | 必填，传入 `0` 由系统分配空闲端口。 |
| `host` | 可选，将监听地址传给 Node。省略时由 Node 选择默认绑定地址。 |
| `shutdownTimeoutMs` | 默认 `30_000` 毫秒，接受 `0` 到 `2_147_483_647` 的整数。到期关闭剩余连接。 |
| `prepare` | 可选 `HttpPrepare`，在监听前收到 Node `Server` 和原生 `handleHttp`，可同步或异步返回 `PreparedHttp`。 |

`HttpHandler` 接收 Node 的 `IncomingMessage` 和 `ServerResponse`，返回 `void` 或 `Promise<void>`。`PreparedHttp` 必须提供 `handle`，可选 `onRouteMiss`、`onUpgrade` 和 `dispose`。`handleHttp` 是 Ainess 的原生请求处理函数。使用 `onRouteMiss` 时由 `handleHttp` 进入 Koa，路由未匹配且 Koa 链执行完后，只有响应未被接管、请求流仍可用的请求才交给回退。需要托管 Next.js 时直接使用 `httpNext()`。 [Next.js 适配器](../http-next/README.md)

关闭时监听器停止接收新连接，通知协议处理方并排空在途响应，关闭剩余连接后执行 `dispose`。进入排空后到达监听回调的请求返回 `503`。监听器负责关闭连接，应用负责先等监听器清理，再释放路由和底层服务。程序使用 `listener.dispose()`，由 framework 装配的应用使用 `running.stop()`。

### 协议升级

`ctx.http.registerUpgrade(handle: HttpUpgradeHandler)` 注册协议处理器并返回撤销函数，注册归调用方 Fiber。`HttpUpgradeHandler` 接收 `HttpUpgrade`，含原生 `request`、`socket`、`head` 和 `signal`。处理器同步返回 `true` 认领连接，随后可异步完成协议握手。返回 `false` 时保留 socket 和数据给下一处理方。抛错或返回 Promise 等非布尔值时，监听器记录错误并销毁 socket。

分发按该次 Upgrade 到达时的注册顺序执行。分发中新注册的处理器从下一次 Upgrade 生效，已撤销的处理器会跳过。最后调用可选的 `PreparedHttp.onUpgrade`，其签名与注册处理器相同。启用分发时，未认领的 Upgrade 返回 `404`。适配器通过这些公开入口加入同一个 `httpListener` 的 Upgrade 分发器。受管分发独占 Node Server 的 `'upgrade'` 事件。原生监听器和受管分发的注册发生冲突时，后加入的一方会收到错误。

`signal` 在监听器开始排空时中止。注册处理器接管的连接可在 `shutdownTimeoutMs` 内完成关闭握手。`PreparedHttp.onUpgrade` 接管的连接随普通 HTTP 响应排空后关闭。需要提供业务 WebSocket 时使用 `websocketHttp`。 [WebSocket 挂载示例](../websocket/README.md#挂载到-http)

## 请求取消

从 `@ainess/http/request-signal` 导入 `getHttpRequestSignal(): AbortSignal | undefined`。它在同一 Node 运行环境的请求上下文中返回当前请求的信号，客户端提前断开时中止，正常响应结束时清理事件监听。上下文之外返回 `undefined`。在 Controller、Koa 中间件和 Node 运行时的 Next.js 服务端代码中，把信号传给支持取消的操作，例如 `fetch(url, { signal: getHttpRequestSignal() })`。

## 验证

在仓库根目录运行 `pnpm test`，或 `pnpm build` 后运行 `node --test packages/http/test/*.test.js`。测试发出真实 HTTP 请求和协议升级，验证路由、一次性校验、目录冲突回滚、并发请求取消隔离和关闭期限。 [HTTP 测试](test/http.test.js) · [Controller 测试](test/controllers.test.js) · [取消测试](test/request-signal.test.js) · [Upgrade 测试](test/upgrade.test.js)
