# @ainess/websocket-shared

命名 WebSocket 端点的公共协议。`@ainess/websocket` 和 `@ainess/websocket-client` 使用同一套帧和流类型。本包使用浏览器和 Node.js 共有的 JavaScript API，运行时依赖为空。

## 公开入口

| 从 `@ainess/websocket-shared` 导入 | 契约 |
| --- | --- |
| `WebSocketMethodMode` | `Unary = 0`、`ClientStream = 1`、`ServerStream = 2`、`Bidi = 3`。数值与 `@ainess/rpc` 的模式对齐。 |
| `isWebSocketMethodMode(value)` | 检查未知值是否为枚举的四个模式之一。 |
| `hasStreamingInput(mode)`、`hasStreamingOutput(mode)` | 判断调用的输入和输出方向是否为流。 |
| `WebSocketFrame`、`encodeWebSocketFrame(frame)`、`decodeWebSocketFrame(message)` | 编码器按 JavaScript JSON 规则生成文本。解码器验证消息类型与信封，非法消息抛出 `WebSocketEndpointError('PROTOCOL_ERROR')`。业务数据可省略。 |
| `WebSocketEndpointError` | 暴露错误 `code`、`message` 和可选 `cause`。线协议只发送应用公开的 `code` 和 `message`。 |
| `WebSocketStreamQueue<Value>` | `push()` 入队，`next()` 或 `for await` 读取。分片和并发读者各自按到达顺序排队，单次入队和取出为常数操作。`end()` 让已入队数据读完，`discard()` 清空队列并结束读取，`fail(reason, { drain? })` 拒绝读取。`drain: true` 保留已入队数据，读完后报告错误。 |
| `waitWithAbort(work, signal)` | 等待一个已开始的异步操作。信号取消时以 `signal.reason` 拒绝等待，异步操作结束时清理信号监听。 |
| `pumpWebSocketStream(source, signal, write)` | 顺序消费 `AsyncIterable` 并等待当前的写入操作。信号取消时停止等待读写，以 `signal.reason` 拒绝，并对已经创建的迭代器调用 `return()`。持续就绪的输入会让出事件循环，给传输层处理回复和取消的机会。 |

## 消息规范

一条 WebSocket 文本消息承载一个 JSON 对象。客户端在每条连接上为方法调用分配递增的正十进制字符串 `id`。同一连接的多个调用可以交错传输，同一调用的分片按收到的顺序读取。协议按收到的帧直接入队，使用调用结束和连接关闭释放队列。

| `type` | 方向 | 字段和行为 |
| --- | --- | --- |
| `call` | 客户端到服务端 | `id`、`name`、`mode`、`data?`。省略 `mode` 表示 `Unary`。服务端校验声明的模式。 |
| `chunk` | 双向 | `id`、`data?`，在相应方向为流时传输块。 |
| `input-end` | 客户端到服务端 | `id`，结束上行。队列中已有的输入仍可读取，服务端可继续输出。 |
| `result` | 服务端到客户端 | `id`、`data?`，单响应调用成功结束。 |
| `end` | 服务端到客户端 | `id`，流式响应成功结束。 |
| `error` | 服务端到客户端 | `id` 和 `error: { code, message }`。`code` 是非空字符串，`message` 是字符串。失败并结束该调用。 |
| `cancel` | 客户端到服务端 | `id`，取消该次调用的输入、输出和业务任务。 |
| `event` | 双向 | `name`、`data?`，按事件名称分发的单向通知。 |

服务端默认错误码包括 `METHOD_NOT_FOUND`、`MODE_MISMATCH`、`INVALID_PARAMS`、`REQUEST_BLOCKED`、`PROTOCOL_ERROR` 和 `INTERNAL_ERROR`。应用可以使用 `WebSocketEndpointError` 提供公开错误。客户端本地还会使用 `NOT_OPEN`、`CANCELLED`、`DEADLINE_EXCEEDED` 和 `DISCONNECTED`。连接关闭时，各调用分别结束，重连建立新的调用 ID 空间。 [服务端](../websocket/README.md#命名端点与中间件) · [客户端](../websocket-client/README.md#调用命名端点)

## 编解码示例

```js
import assert from 'node:assert/strict'
import { decodeWebSocketFrame, encodeWebSocketFrame, WebSocketMethodMode } from '@ainess/websocket-shared'

const frame = { type: 'call', id: '1', name: 'generate', mode: WebSocketMethodMode.ServerStream }
assert.equal(decodeWebSocketFrame(encodeWebSocketFrame(frame)).mode, WebSocketMethodMode.ServerStream)
```

根目录运行 `pnpm test`，或执行 `pnpm --filter @ainess/websocket-shared build` 后运行 `node --test packages/websocket-shared/test/*.test.js`。
