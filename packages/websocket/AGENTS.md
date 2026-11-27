# @ainess/websocket 开发指引

公开类型、两个入口与运行示例见[使用手册](README.md)。

- `websocket` 提供 Cordis 服务 `ctx.websocket`。消费插件声明 `inject: ['websocket']`，用 `route(path, endpoint)` 按原始路径注册端点。路径区分大小写并忽略查询字符串。注册归调用方 Fiber，注销时取消在途握手并关闭该路由在各入口上的连接。
- 主入口导出 `websocketListener`。它用 Node 原生 HTTP Server 接收标准 WebSocket 握手并监听独立端口。应用等待监听 Fiber 的 `await()`，通过 `ctx.websocket.address()` 查询地址。传输使用 `ws`，公共帧使用 `@ainess/websocket-shared`，Cordis 由宿主提供。应用可用 Node.js 类型配置严格检查公开声明。
- `@ainess/websocket/http` 导出 `websocketHttp`，它声明 `http` 和 `websocket` 两个注入。它在 HTTP 监听器上注册 Upgrade 处理器，匹配后由服务执行同一套握手。`@ainess/http` 由选择挂载的应用提供。端口、关闭期限和未命中回退由 HTTP 入口管理。
- `authorize({ request, signal })` 在升级前执行，允许携带类型化状态，也可返回固定 HTTP 状态拒绝。握手超时、卸载和断连取消信号，异步完成的鉴权结果随已取消的握手作废。`ws` 管理 RFC 6455 校验、消息解析、帧写入和关闭握手。
- 原生路由的 `onOpen` 与 `onMessage` 按单连接顺序执行，每连接拥有独立的有界队列。`send()` 等待本地写入回调。服务关闭时撤销入口和路由的接收能力，取消连接信号并发 `1001`，超过所属关闭期限则销毁 socket。收到和发送的消息均保持文本与二进制的区别。心跳定时器随服务 Fiber 清理。
- `defineWebSocketEndpoint()` 提供命名方法、事件和端点中间件。它按 ID 分发调用，由独立异步任务消费流和执行业务。取消调用会结束对异步 Schema 校验和流读写的等待。事件顺序处理，中间件抛错后等待该事件已启动的下游，断连时清空待处理事件。中间件须在执行完成前调用 `next()`。分发器等待同步中间件启动的下游，异步中间件可处理 `await next()` 的异常。未调用 `next()` 则拦截事件或让方法返回 `REQUEST_BLOCKED`。错误观察回调异步运行。`defineWebSocketMethod()` 推导启动参数与分片的 Standard Schema 输出类型。
- 显式指定方法的 Schema 类型时须传入对应的运行时 Schema。调用完成时先释放尚未消费的上行数据，再发送终态帧，迟到的分片按已结束的调用处理。
- 命名方法只公开具备非空字符串错误码和字符串消息的 `WebSocketEndpointError`。其他异常以 `INTERNAL_ERROR` 结束对应调用，原始异常交给 `onError`。
- `@ainess/websocket/loader` 复用 `@ainess/loader` 扫描 `.ws` 模块。每个文件默认导出同步的端点工厂。返回 Promise 或其他可等待的值会导致装配报错。路径采用静态段、分组目录和 `index`，并使用 WebSocket URL 的路径编码。导入前检查同批冲突，注册失败回滚本批。依赖解析、撤销监听和路由注册使用传入的 Context，装配归调用方 Fiber。
- 在根目录运行 `pnpm test`。集成测试通过开发依赖 `@ainess/websocket-client` 建立真实连接，覆盖双入口共用路由、端口重用、鉴权、中间件、流并发、原生路由的容量上限和 Fiber 清理。Next.js 的同端口 HMR 与业务 WebSocket 用例在 `@ainess/http-next` 集成测试中执行。
