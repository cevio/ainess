# @ainess/websocket-client 开发指引

公开接口和浏览器接入示例见[使用手册](README.md)。

- 客户端主入口导出 `connectWebSocket()`、`connectWebSocketEndpoint()` 和配套类型。使用浏览器或 Node.js 的原生 WebSocket、URL、AbortSignal 和计时器。生产源码只使用 ES 与 DOM 类型，运行时依赖为 `@ainess/websocket-shared`。
- 一个客户端持有当前原生连接和重连计时器，并沿用创建时读取的连接配置。异常断线或远端关闭后按关闭码与重试预算决定是否重连。延迟使用封顶指数退避和抖动。成功打开后重置连续失败次数。
- `close()` 和外部中止信号永久停止该客户端的重试并关闭当前连接。每次拨号前检查信号，重新建立连接时再次触发 `onOpen`。消息保持文本或二进制，`send()` 只接受已打开的连接。
- 命名客户端提供 `call`、`stream`、`emit`、`on`，按连接内的 `id` 关联结果和分片。调用按实际发送顺序编号，发送前检查取消状态。调用读取一次 `input`，用同一个值判定上行模式并启动上传。取消、超时、终态和断线时清理对应调用，远端订阅在重连后由业务重新登记。
- 连接级中止在发起关闭握手时清理命名调用。批量清理时先移出全部在途调用，再通知上传源，确保回调重入时保留本次关闭原因。遇到非法响应帧时先关闭传输，再以 `PROTOCOL_ERROR` 清理。
- 在根目录运行 `pnpm test`，或构建后运行 `node --test packages/websocket-client/test/*.test.js`。真实连接测试覆盖重试预算、取消和握手时限。服务端重启后的回显测试位于 `@ainess/websocket`。
