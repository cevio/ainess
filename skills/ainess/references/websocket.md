# @ainess/websocket

在 `plugins` 安装 `websocket`。消费插件声明 `inject: ['websocket']`，用 `ctx.websocket.route(path, { authorize?, onOpen?, onMessage?, onClose? })` 注册精确路径。鉴权在 `101` 前用 `{ accept: true, state }` 传递状态，或用 `{ accept: false, status }` 拒绝。将握手或连接的 `signal` 传给支持取消的下游任务。 [包手册](https://github.com/cevio/ainess/blob/main/packages/websocket/README.md)

独立模式用主入口的 `websocketListener`，`ctx.websocket.address()` 返回实际地址。它自己绑定端口，宿主提供 Cordis，`ws` 由包提供。挂载模式同时装配 `@ainess/http` 和 `@ainess/websocket/http` 的 `websocketHttp`，然后用 `httpListener` 开启共享端口。业务处理函数可同时服务两个入口。浏览器重连使用独立的客户端包。 [WebSocket 客户端](websocket-client.md)

## 运行两种入口

示例需要 `@ainess/framework`、`@ainess/websocket`、`@deepseek-ai/cordis` 和用于挂载演示的 `@ainess/http`。将代码保存为 `echo.mjs`，运行 `node echo.mjs`。它在两个空闲端口使用同一个端点，验证回显和关闭握手。

```js
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { defineApp, use } from '@ainess/framework'
import { http, httpListener } from '@ainess/http'
import { websocket, websocketListener } from '@ainess/websocket'
import { websocketHttp } from '@ainess/websocket/http'

const host = '127.0.0.1'
const app = defineApp({
  plugins: {
    http: use(http),
    websocket: use(websocket),
    mounted: use(websocketHttp),
    echo: use({
      inject: ['websocket'],
      apply(ctx) {
        ctx.websocket.route('/ws/echo', {
          onMessage: (connection, message) => connection.send(message),
        })
      },
    }),
  },
  entries: {
    web: use(httpListener, { host, port: 0 }),
    socket: use(websocketListener, { host, port: 0 }),
  },
})

const running = await app.start()
const closed = []
try {
  for (const address of [running.ctx.http.address(), running.ctx.websocket.address()]) {
    assert.ok(address)
    const client = new WebSocket(`ws://${host}:${address.port}/ws/echo`)
    const signal = AbortSignal.timeout(5_000)
    await once(client, 'open', { signal })
    closed.push(once(client, 'close', { signal }))
    const reply = once(client, 'message', { signal })
    client.send('hello')
    assert.equal((await reply)[0].data, 'hello')
  }
} finally {
  await running.stop()
  for (const [event] of await Promise.all(closed)) assert.equal(event.code, 1001)
}
```

仅启动独立入口时，装配 `websocket`、`echo` 和 `socket`。将业务 WebSocket 与 Next.js 共用端口时，为 `web` 加上 `prepare: httpNext(...)`，端口归 `httpListener`。等待 `running.stop()` 或各入口的 `Fiber.dispose()`，再卸载应用。撤销路由会取消在途握手并关闭它在两个入口上的连接。 [Next.js](http-next.md) · [框架生命周期](framework.md)

## 按文件装配命名端点

安装 `@ainess/websocket`、`@ainess/websocket-client` 和宿主的 `@deepseek-ai/cordis`。创建 `ws/echo.ws.mjs`。编写 TypeScript 时可用 `ws/echo.ws.ts`，并在应用配置中指向编译产物目录。

```js
import { defineWebSocketEndpoint, defineWebSocketMethod, WebSocketEndpointError, WebSocketMethodMode } from '@ainess/websocket'

/** @type {import('@standard-schema/spec').StandardSchemaV1<unknown, number>} */
const numberSchema = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate: value => typeof value === 'number' ? { value } : { issues: [{ message: 'Expected a number' }] },
  },
}

export default () => defineWebSocketEndpoint({
  middlewares: [async ({ kind, name }, next) => {
    if (kind === 'method' && name === 'admin') throw new WebSocketEndpointError('FORBIDDEN')
    await next()
  }],
  methods: {
    echo: { handle: data => data },
    admin: { handle: () => ({ ok: true }) },
    sum: defineWebSocketMethod({
      mode: WebSocketMethodMode.ClientStream,
      inputSchema: numberSchema,
      async handle(_data, { input }) {
        let total = 0
        for await (const value of input) total += value
        return total
      },
    }),
  },
  events: {
    typing: { handle: (data, { emit }) => emit('typing.changed', data) },
  },
})
```

保存下面的 `demo.mjs`，运行 `node demo.mjs`。装配和原生监听完成后，对同一条连接发起单次调用、上传流并发送事件，同时检查中间件拦截。上传方法可以提前返回，服务端在发送结果前释放上行队列，客户端收到结果后结束上传。

```js
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { websocket, websocketListener } from '@ainess/websocket'
import { websocketRoutes } from '@ainess/websocket/loader'
import { connectWebSocketEndpoint } from '@ainess/websocket-client'

const app = new Context()
try {
  await app.plugin(websocket).await()
  await app.plugin(websocketRoutes({ directory: new URL('./ws/', import.meta.url), prefix: '/ws' })).await()
  const listener = await app.plugin(websocketListener, { host: '127.0.0.1', port: 0 }).await()
  try {
    const address = app.websocket.address()
    assert.ok(address)
    const events = new EventEmitter()
    const signal = AbortSignal.timeout(5_000)
    const ready = once(events, 'open', { signal })
    const client = connectWebSocketEndpoint(`ws://127.0.0.1:${address.port}/ws/echo`, {
      signal,
      onOpen() { events.emit('open') },
    })
    try {
      await ready
      const reply = await client.call('echo', { text: 'hello' })
      assert.deepEqual(reply, { text: 'hello' })
      await assert.rejects(client.call('admin'), { code: 'FORBIDDEN' })
      assert.equal(await client.call('sum', undefined, {
        async *input() {
          yield 2
          yield 3
        },
      }), 5)
      const event = once(events, 'typing', { signal })
      const unsubscribe = client.on('typing.changed', data => { events.emit('typing', data) })
      client.emit('typing', { active: true })
      assert.deepEqual(await event, [{ active: true }])
      unsubscribe()
    } finally {
      client.close()
    }
  } finally {
    await listener.dispose()
  }
} finally {
  await app.fiber.dispose()
}
```

`websocketRoutes()` 从目录名、分组和 `index` 生成 URL 编码的静态路径。重复路径在导入前报错，路由工厂必须同步返回，注册失败撤回本批路由。直接使用 `loadWebSocketRoutes(ctx, options)` 时，服务和路由都位于传入的 Cordis 作用域。中间件在本次执行完成前可调用一次 `next()`。分发器等待同步中间件启动的下游。事件按接收顺序处理，中间件抛错时也会等待当前事件已启动的下游结束。中间件可以用 `await next()` 捕获下游异常，通过带非空字符串错误码的 `WebSocketEndpointError` 指定公开错误。框架应用可把 Loader 放进 `plugins`，独立或共享监听器放进 `entries`。命名帧与模式由公共包维护。 [公共协议](websocket-shared.md)
