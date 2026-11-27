# @ainess/websocket-shared

浏览器可加载的公共协议包。`WebSocketMethodMode.Unary`、`ClientStream`、`ServerStream`、`Bidi` 的取值为 `0`、`1`、`2`、`3`。服务端与客户端也从各自主入口重新导出同一个枚举。 [帧规范与公开接口](https://github.com/cevio/ainess/blob/main/packages/websocket-shared/README.md)

用 `encodeWebSocketFrame` 和 `decodeWebSocketFrame` 处理 JSON 文本。客户端通过 `id` 关联 `call`、`chunk`、`input-end`、`result`、`end`、`error` 和 `cancel`。`event` 按名称分发。`WebSocketStreamQueue` 按到达顺序交付分片和唤醒并发读者，关闭或失败时释放等待读者。`pumpWebSocketStream` 按顺序提交数据，取消时通过 `waitWithAbort()` 停止等待读写，并请求关闭源迭代器。应用通过两端主入口即可使用业务调用。 [服务端](websocket.md#按文件装配命名端点) · [客户端](websocket-client.md)

```js
import { encodeWebSocketFrame, WebSocketMethodMode } from '@ainess/websocket-shared'

const message = encodeWebSocketFrame({ type: 'call', id: '1', mode: WebSocketMethodMode.Unary, name: 'echo' })
console.log(message)
```
