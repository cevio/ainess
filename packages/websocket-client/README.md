# @ainess/websocket-client

在现代浏览器或 Node.js 中使用原生 WebSocket。运行时使用浏览器可加载的 `@ainess/websocket-shared`。 [原生 WebSocket API](https://websockets.spec.whatwg.org/#the-websocket-interface) · [公共协议](../websocket-shared/README.md)

## 接入

应用向 `connectWebSocket()` 传入实际 `ws://` 或 `wss://` 地址。以下函数在每次成功打开连接时发送同一条应用消息，返回组件或任务结束时使用的清理函数。可用服务端手册的回显端点验证。 [服务端回显示例](../websocket/README.md#独立启动)

```js
import { connectWebSocket } from '@ainess/websocket-client'

export function connectEcho(url, showMessage) {
  const client = connectWebSocket(url, {
    onOpen(connection) { connection.send('hello') },
    onMessage(message) { showMessage(message) },
  })
  return () => client.close()
}
```

## 公开接口

`connectWebSocket(url: string | URL, options?: WebSocketClientOptions): WebSocketClient` 立即发起首次连接并返回客户端。重连沿用创建时读取的连接配置。无效地址、协议或选项会在创建时抛出。客户端在每次拨号前检查 `signal`，首次拨号前的中止会直接抛出中止原因。

| 选项 | 默认值 | 行为 |
| --- | --- | --- |
| `protocols` | 省略 | 字符串或字符串数组，传给原生 WebSocket 的子协议参数。 |
| `signal` | 省略 | 中止后关闭当前连接并停止计时器与重连。 |
| `connectTimeoutMs` | `10_000` | 每次拨号等待打开事件的毫秒数，超时关闭该次连接。 |
| `initialDelayMs` | `500` | 第一次重连的退避基数，随后逐次翻倍。 |
| `maxDelayMs` | `10_000` | 退避上限。实际等待在本次上限的约一半到上限之间随机选取。 |
| `maxAttempts` | `Infinity` | 从首次拨号失败或连接关闭后开始，允许发起的连续重试次数。打开连接后重置，传入 `0` 只拨号一次。 |
| `shouldReconnect(close)` | 按关闭码判断 | 覆盖重连判定，仍受重试预算及取消约束。默认结束 `1000`、`1002`、`1003`、`1007`、`1008`、`1009` 和 `1010`，对 `1001`、`1006` 等重连。 |

时长单位为毫秒，接受 `1` 到 `2_147_483_647` 的整数。`maxDelayMs` 至少等于 `initialDelayMs`。`maxAttempts` 接受 `0` 到 `2_147_483_647` 的整数或 `Infinity`。 [关闭码与异常断开恢复](https://www.rfc-editor.org/rfc/rfc6455#section-7.2.3)

- `onOpen(client)` 在每次成功打开时调用。应用可在此恢复订阅。`onMessage(message, client)` 的 `WebSocketClientMessage` 是 `string | Uint8Array`。
- `onClose(close, client)` 每次连接结束时调用。`WebSocketClientCloseInfo` 包含 `code`、`reason` 和 `wasClean`。`onError(error, client)` 接收原生错误事件与业务回调异常。
- `client.readyState` 使用原生 `WebSocket` 状态码，等待重连时为 `CONNECTING`。`client.send(message)` 同步交给当前 `OPEN` 连接。其他状态抛出错误，调用方可在下次 `onOpen` 时决定要发送的内容。
- `client.close(code?, reason?)` 默认发送 `1000`，关闭当前连接并停止重试。销毁客户端可重复调用 `close()`，或通过 `AbortController` 管理其生命周期。

浏览器将部分握手失败报告为 `1006`。可按应用需要设置 `maxAttempts`，在业务恢复认证后重新创建客户端。 [浏览器关闭事件规则](https://websockets.spec.whatwg.org/#feedback-from-the-protocol)

## 调用命名端点

`connectWebSocketEndpoint(url, options?)` 返回 `WebSocketEndpointClient`。`WebSocketEndpointClientOptions` 沿用原生客户端的连接、重试、子协议和取消选项。`onOpen`、`onClose` 和 `onError` 收到命名客户端。

| 接口 | 行为 |
| --- | --- |
| `call<Result>(name, data?, options?)` | 返回 `Promise<Result>`。提供 `input` 时使用客户端流。 |
| `stream<Chunk>(name, data?, options?)` | 发起调用并返回 `AsyncIterableIterator<Chunk>`。提供 `input` 时使用双向流。迭代提前退出会取消本次调用。 |
| `emit(name, data?)` | 发送一条事件。 |
| `on<Data>(name, handler)` | 订阅服务端事件。返回撤销函数。订阅随这个客户端实例跨重连保留。 |
| `readyState`、`close(code?, reason?)` | 查询原生状态或关闭连接、结束在途调用并停止重连。 |

`WebSocketCallOptions` 可传 `input(signal): AsyncIterable<Input>`、`signal` 和 `timeoutMs`。在发送调用前触发的中止直接结束本地调用。`input` 自然结束时关闭调用的上行。取消、迭代器退出、超时或远端终态会停止上行源。`timeoutMs` 以毫秒计，范围为 `1` 到 `2_147_483_647`，省略时持续等待响应。调用失败抛出 `WebSocketEndpointError`，可按 `code` 处理。收到远端流错误时，迭代器先交付已收到的分片，再报告错误。连接重建后，在 `onOpen` 恢复需要在服务端登记的订阅或发起新的方法调用。 [可运行的服务端和客户端示例](../../skills/ainess/references/websocket.md#按文件装配命名端点)

连接级 `signal` 中止会立即以 `DISCONNECTED` 结束在途调用，`onClose` 仍在底层连接结束时触发。收到非法响应帧时，客户端先关闭传输，再以 `PROTOCOL_ERROR` 结束所有在途调用。清理期间发起的新调用会收到 `NOT_OPEN`。

## 验证

运行根目录 `pnpm test`。也可先运行 `pnpm --filter @ainess/websocket-client build`，再执行 `node --test packages/websocket-client/test/*.test.js`。服务端的真实重启和二进制回显测试是 `packages/websocket/test/client.test.js`。
