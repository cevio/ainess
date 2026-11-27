# @ainess/websocket-client

从 `@ainess/websocket-client` 导入 `connectWebSocket(url, options?)` 或 `connectWebSocketEndpoint(url, options?)`。客户端使用浏览器或 Node.js 的原生 WebSocket 和浏览器可加载的 `@ainess/websocket-shared`。服务重启或连接异常时沿用创建时的连接配置，按带抖动的指数退避重新连接。每次 `onOpen(client)` 可恢复该连接的远端订阅。首次拨号前的中止会直接抛出原因，`client.close()` 或 `AbortSignal` 可以取消后续重连。 [包手册](https://github.com/cevio/ainess/blob/main/packages/websocket-client/README.md)

以下例子可连接 WebSocket 服务端参考中的 `/ws/echo`。传入实际发布地址。回显端点收到文本或 `Uint8Array` 后返回原消息。

```js
import { connectWebSocket } from '@ainess/websocket-client'

export function connectEcho(url, onMessage) {
  const controller = new AbortController()
  connectWebSocket(url, {
    signal: controller.signal,
    maxAttempts: 8,
    onOpen(client) { client.send('hello') },
    onMessage,
  })
  return () => controller.abort()
}
```

在页面、组件或调用任务离开时调用清理函数。待连接时 `client.readyState` 为 `WebSocket.CONNECTING`，在 `WebSocket.OPEN` 时调用 `send()`。鉴权失败在浏览器可能只表现为异常断开，可以用 `maxAttempts` 限制连续重试。 [WebSocket 服务端](websocket.md#运行两种入口)

命名端点使用 `call()` 等待单响应，使用 `stream()` 消费流式响应。`{ input: signal => source(signal) }` 提供上行流。`emit()` 发送事件，`on()` 订阅远端事件并返回撤销函数。通过调用选项的 `signal`、`timeoutMs` 或提前退出响应迭代器来结束单次调用。断线或连接级中止会结束该连接的全部在途调用。响应帧非法时，客户端关闭传输并以 `PROTOCOL_ERROR` 结束在途调用。 [与 Loader 配套的端到端示例](websocket.md#按文件装配命名端点)
