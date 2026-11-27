# @ainess/websocket

给 Cordis 应用提供 WebSocket 服务。业务通过 `ctx.websocket.route()` 注册端点，应用选择独立监听或挂载到 `@ainess/http`。同一份业务路由可以由两个入口提供。

浏览器和 Node.js 应用可用独立的 `@ainess/websocket-client` 建连和自动重连。 [客户端使用手册](../websocket-client/README.md)

## 独立启动

应用安装 `@ainess/websocket` 和工作区兼容的 `@deepseek-ai/cordis`。包使用 `ws` 实现 WebSocket 协议。独立入口直接绑定端口，用 Node 原生 HTTP Server 完成建连时的 Upgrade 握手。客户端收到 `101` 后通过 WebSocket 帧收发消息。普通 HTTP 请求返回 `404`。 [WebSocket 协议](https://www.rfc-editor.org/rfc/rfc6455#section-1.3)

将以下代码保存为 `echo.mjs` 后运行 `node echo.mjs`。它使用空闲端口监听，发出一次真实消息并等待连接和监听器清理。

```js
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { websocket, websocketListener } from '@ainess/websocket'

const app = new Context()
try {
  await app.plugin(websocket).await()
  await app.plugin({
    inject: ['websocket'],
    apply(ctx) {
      ctx.websocket.route('/ws/echo', {
        onMessage: (connection, message) => connection.send(message),
      })
    },
  }).await()

  const listener = app.plugin(websocketListener, { host: '127.0.0.1', port: 0 })
  try {
    await listener.await()
    const address = app.websocket.address()
    assert.ok(address)
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/ws/echo`)
    const signal = AbortSignal.timeout(5_000)
    await once(client, 'open', { signal })
    const reply = once(client, 'message', { signal })
    client.send('hello')
    assert.equal((await reply)[0].data, 'hello')
    const closed = once(client, 'close', { signal })
    await listener.dispose()
    assert.equal((await closed)[0].code, 1001)
  } finally {
    await listener.dispose()
  }
} finally {
  await app.fiber.dispose()
}
```

## 挂载到 HTTP

应用另外安装 `@ainess/http`。先安装 `http`、`websocket`、业务路由和 `websocketHttp`，再挂载 `httpListener`。使用 framework 时，将四者放在 `plugins`，将监听器放在 `entries`。在上述例子中改用以下装配，客户端用 `app.http.address()` 查询共享端口。 [完整应用配置](../../skills/ainess/references/websocket.md#运行两种入口) · [HTTP 监听器](../http/README.md#监听与适配器)

```js
import { http, httpListener } from '@ainess/http'
import { websocketHttp } from '@ainess/websocket/http'

await app.plugin(http).await()
await app.plugin(websocketHttp).await()
const listener = app.plugin(httpListener, { host: '127.0.0.1', port: 0 })
```

共享监听器优先将命中的 WebSocket 握手交给业务路由。使用 `httpNext()` 时，剩余 Upgrade 交给 Next.js 的原生处理器，开发态 HMR 继续使用共享端口。普通 HTTP 请求仍按其 HTTP 路由处理，可以和 WebSocket 使用相同路径。 [Next.js 装配](../http-next/README.md)

## 公开接口

| 导入入口 | 接口 | 用法 |
| --- | --- | --- |
| `@ainess/websocket` | `websocket`、`WebSocketOptions`、`WebSocketService` | 安装 `websocket` 服务。消费插件声明 `inject: ['websocket']`。 |
| `@ainess/websocket` | `websocketListener`、`WebSocketListenerOptions` | 使用 `{ host?, port, shutdownTimeoutMs? }` 挂载独立入口。`port: 0` 使用空闲端口，省略 `host` 时由 Node 选择绑定地址。`shutdownTimeoutMs` 默认 `30_000` 毫秒，接受 `0` 到 `2_147_483_647`。同一服务可装配一个独立监听器。 |
| `@ainess/websocket` | `defineWebSocketEndpoint()`、`defineWebSocketMethod()` | 定义同一端点的命名方法、事件和中间件。通过 `WebSocketMethodMode` 声明数据流方向。 |
| `@ainess/websocket/http` | `websocketHttp` | 安装共享端口适配器。Fiber 自动注入 `http` 和 `websocket`，在卸载时撤销 Upgrade 注册并清理该入口的连接。 |
| `@ainess/websocket/loader` | `websocketRoutes()`、`loadWebSocketRoutes()` | 扫描 `.ws` 模块并按文件路径注册端点。 |

`ctx.websocket.address()` 返回独立监听器的 `AddressInfo`，未绑定或已关闭时返回 `null`。共享端口由 `ctx.http.address()` 提供。`Fiber.await()` 等待端口绑定，绑定失败向调用方传出原始错误并清理该监听器。

| 服务选项 | 默认值 | 行为 |
| --- | --- | --- |
| `maxPayload` | `1_048_576` 字节 | 原生路由单条入站消息的最大长度。超长消息关闭对应连接。 |
| `maxBufferedBytes` | `4_194_304` 字节 | 原生路由的入站队列字节数及本地发送积压上限。发送超出上限时 `send()` 拒绝。 |
| `heartbeatIntervalMs` | `30_000` 毫秒 | 每隔此时长发送 ping。到下一轮仍未收到 pong 时结束连接，`0` 关闭心跳。 |
| `handshakeTimeoutMs` | `5_000` 毫秒 | 路由认领 Upgrade 后等待鉴权和握手的时限，早于 `101` 超时返回 `408`。 |
| `closeTimeoutMs` | `5_000` 毫秒 | 主动关闭连接、卸载端点、适配器或服务的等待上限。关闭监听器使用对应入口的 `shutdownTimeoutMs`。`0` 表示尽快结束剩余连接。 |

这些选项接受上限为 `2_147_483_647` 的整数。消息大小、缓冲上限和握手时限至少为 `1`。服务禁用 WebSocket 消息压缩。 [ws 服务端选项](https://github.com/websockets/ws/blob/master/doc/ws.md#new-websocketserveroptions-callback)

### 端点与连接

`ctx.websocket.route(path, endpoint)` 返回可重复调用的异步撤销函数。路径以 `/` 开头，区分大小写，按原始路径做精确匹配，保留百分号编码。查询字符串不参与匹配。路径中的空白、`?` 或 `#` 抛出 `TypeError`，重复注册同一路径抛出异常。路由随调用方 Fiber 撤销。

- `WebSocketRoute<State>` 描述端点回调。可选的 `authorize` 是 `WebSocketAuthorize<State>`，接受 `WebSocketHandshake` 的 `{ request, signal }`。返回 `WebSocketAuthorization<State>` 的 `{ accept: true, state }` 允许握手并传递状态。用 `{ accept: false, status }` 返回 `400`、`401`、`403` 或 `429`。抛出或拒绝时结束握手并记录错误。省略鉴权的端点直接接受合法握手，`state` 为 `undefined`。基于 Cookie 的认证可在此处同时检查允许的 `Origin`。
- `onOpen(connection)` 先于消息回调。`onMessage(connection, message)` 在同一连接内串行处理，消息类型 `WebSocketMessage` 为 `string | Uint8Array`。等待队列最多 `256` 条消息，并受 `maxBufferedBytes` 约束。接收积压超限时关闭码为 `1013`，业务回调出错时关闭码为 `1011`。不同连接独立处理。
- `WebSocketConnection<State>` 提供 `state`、`signal`、`send(message): Promise<void>` 和 `close(code?, reason?): void`。`signal` 在连接结束或进入关闭时中止。`send()` 在本地写入回调后完成，消息送达确认由应用协议负责。`close()` 默认用 `1000` 发起关闭握手。
- `onClose(connection, info)` 在底层连接关闭后通知一次。`WebSocketCloseInfo` 提供 `code` 和 `reason`。异步通知独立完成，拒绝交给 Cordis 日志。

关闭某个入口只清理它接入的连接。关闭应用时先等待入口 Fiber 排空，再卸载根 Fiber。撤销端点时，该端点停止接收新的握手，取消在途鉴权，并向它的连接发送 `1001`。新注册可以复用同一路径。到达关闭时限时销毁剩余 socket。 [Cordis 应用生命周期](../framework/README.md#就绪失败与停止)

## 命名端点与中间件

用 `defineWebSocketEndpoint(options)` 生成 `WebSocketRoute<State>`。同一个路径下的 `methods` 和 `events` 分别按名称分发。服务端用 `WebSocketMethodMode.Unary`、`ClientStream`、`ServerStream` 或 `Bidi` 声明方法的流向，省略 `mode` 时等待单响应。两端共用枚举和 JSON 帧协议。 [消息规范](../websocket-shared/README.md#消息规范)

- `WebSocketEndpointOptions` 可提供 `authorize`、`methods`、`events`、`middlewares`、`onOpen`、`onClose` 和 `onError`。`WebSocketEndpointContext` 提供鉴权后的 `connection.state` 和向当前连接发送事件的 `emit(name, data?)`。`onOpen` 和 `onClose` 异步通知连接状态，业务依赖的握手初始状态可以在 `authorize` 中准备。`onError` 异步观察业务和事件异常，后续事件可以继续处理。
- 方法的 `schema` 校验启动数据，`inputSchema` 在消费时校验上行流块。Schema 使用 `StandardSchemaV1`，例如业务应用可传入 Zod Schema。`defineWebSocketMethod()` 根据传入的 Schema 推导 `handle(data, ctx)` 的入参类型。显式指定具体的 Schema 泛型时，需要同时传入对应的 Schema。方法上下文 `WebSocketMethodContext` 的 `signal` 属于本次调用。`ClientStream` 和 `Bidi` 的类型提供 `ctx.input` 和 `inputSchema`，`ServerStream` 和 `Bidi` 的 handler 返回 `AsyncIterable`。 [Standard Schema](https://standardschema.dev/)
- `middlewares` 是按声明顺序执行的 `WebSocketEndpointMiddleware` 数组，每项必须是函数。`WebSocketMiddlewareContext` 提供 `kind`、`name`、解析后的 `data` 和调用上下文。中间件应在本次执行完成前最多调用一次 `next()`。同步中间件可以调用 `next()` 后把等待交给分发器。用 `await next()` 包住执行过程，并可捕获下游异常。执行完成前未调用 `next()` 会拦截事件，方法收到 `REQUEST_BLOCKED`。输出流全部发送完后，`next()` 才完成。连接鉴权在握手阶段执行，分片、结束和取消由帧分发器处理。
- handler 和中间件可以抛出 `WebSocketEndpointError('FORBIDDEN')` 来指定公开错误，要求 `code` 是非空字符串、`message` 是字符串。其他异常通过 `INTERNAL_ERROR` 结束对应调用，原始异常交给 `onError`。
- 方法按调用 ID 独立运行，帧分发可以同时推进。事件保持入站顺序，即使中间件抛出异常，下一个事件也会等待已启动的下游工作结束。调用完成时，服务端在写入终态帧之前释放上行队列，随后到达的上行分片会被丢弃。取消或断线时，调用停止等待异步 Schema 校验和流读写。连接关闭时清空尚未处理的事件。应用可以把方法或连接的取消信号传给下游。 [可运行的调用与事件示例](../../skills/ainess/references/websocket.md#按文件装配命名端点)

## 按目录装配

`@ainess/websocket/loader` 提供两个入口。`websocketRoutes({ directory, prefix?, extensions?, inject? })` 创建 Cordis 插件，自动注入 `websocket` 和 `inject` 指定的服务。`inject` 的每项须为非空服务名，重复名称会合并。已有消费插件可直接 `await loadWebSocketRoutes(ctx, { directory, prefix?, extensions? })`，并在自己的 `inject` 声明所需服务。Loader 在传入的 Context 中解析服务、监听服务撤销并注册路由，支持使用 Cordis 隔离作用域。

`directory` 为路径或文件 URL，默认扩展名是 `.js` 和 `.mjs`，文件后缀固定为 `.ws`。TypeScript 源码通常编译到对应的 `.ws.js`，原生环境可用 `extensions` 替换扩展名列表。模块默认导出同步 `WebSocketRouteModule<State>`，接收注册方 `ctx` 并返回一个路由。工厂返回 Promise 或其他带有可调用 `then` 的值时，Loader 报告启动错误。

当扫描目录为 `ws/`、`prefix` 为 `/ws` 时，`ws/echo.ws.ts` 的编译产物映射到 `/ws/echo`。`index` 映射到所在目录，`(group)` 从路径中省略。静态路径使用 WebSocket URL 的路径编码，保留已写入的百分号转义。整批路径在导入前检查动态段、通配段、编码点段和重复路径。文件按相对路径顺序导入。注册冲突会撤回本批已经注册的路由。装配 Fiber 或依赖被撤销时，已开始的导入收尾，后续文件跳过。卸载装配 Fiber 时关闭本批路由上的连接。 [目录装配示例](../../skills/ainess/references/websocket.md#按文件装配命名端点)

## 验证

从仓库根目录运行 `pnpm test`。快速验证可以先运行 `pnpm --filter @ainess/websocket... run build`，再运行 `node --test packages/websocket/test/*.test.js`。同一端口上的 Next.js 与业务 WebSocket 由 `pnpm --filter @ainess/http-next test:integration` 验证。
