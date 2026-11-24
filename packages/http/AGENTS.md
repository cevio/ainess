# @ainess/http 开发指引

公开接口和路由示例见[使用手册](README.md)。

- `http` 是 Cordis 服务插件。消费插件声明 `inject: ['http']`，通过 `ctx.http.use()` 和 `ctx.http.route()` 注册 Koa 中间件与显式路由。每次注册归调用方 Fiber，卸载时撤销。`ctx.http.route()` 返回该路由的清理函数。Koa 负责请求与响应，find-my-way 负责匹配。
- `defineController(handle)` 和 `defineController({ schema?, handle })` 都生成路由中间件。带有 `handle` 属性的可调用对象也按配置处理。声明时验证 `handle` 和可选 `schema` 的调用形态。`handle` 接收原始 Koa 上下文和 `{ params, query, body }`。提供 Standard Schema 时，先校验一次，再把解析结果作为第二个参数。校验失败抛出 `400`，校验问题附在错误的 `issues` 上。返回值为 `undefined` 时保留 handler 设置的响应。`body` 由前置解析中间件提供。
- `@ainess/http/controllers` 的 `loadHttpControllers(ctx, { directory, prefix?, extensions? })` 由消费插件在 `apply()` 中等待。插件声明 `http` 以及各工厂需要的服务注入。默认扫描 `*.controller.js` 和 `*.controller.mjs`。模块默认导出同步工厂，接收调用方 `ctx` 并返回单个 `{ method, middlewares }` 或这些定义组成的非空数组。
- 同一入口导出 `httpControllers({ directory, prefix?, extensions?, inject? })`，生成负责目录装配的 Cordis 插件。它自动注入 `http`，应用通过 `inject` 数组声明该批 Controller 工厂需要的其他服务。创建插件时校验注入列表。
- 目录装配复用 `@ainess/loader` 的扫描和文件路由语法。先校验整批路径，再导入模块并检查 Controller 定义。文件目录中的 `(group)` 段从 URL 中省略。批量注册归调用方 Fiber，冲突时回滚本批，错误包含文件路径及原因。`[...name]` 只匹配非空剩余路径，并将其作为字符串放在 `request.params[name]`。更具体的通配路由没有剩余路径时，路由器继续寻找同方法的匹配。加载期间卸载插件或撤销必需服务会跳过后续模块导入、剩余工厂及本批注册。
- `httpListener` 依赖 `http`。应用完成路由装配后再安装监听插件，并用 `Fiber.await()` 等待端口绑定。可选的 `prepare(server, handleHttp)` 在监听前运行，可返回请求处理函数、`onRouteMiss` 回退和清理函数。`ctx.http.address()` 返回实际监听地址。
- `onRouteMiss` 随监听 Fiber 生效。请求到达路由器且未匹配时，Koa 中间件链先完成。未接管响应且原始请求流可继续读取时，HTTP 才把原生请求和响应交给回退函数。匹配路由的响应和中间件主动设置的响应归 Koa 处理。
- 监听 Fiber 管理 Node HTTP Server、连接和关闭期限。应用先等待监听 Fiber 排空并释放适配器，再卸载根 Fiber。启动失败时释放已获取的资源，保留原始错误。提供者在准备期间卸载时，监听 Fiber 回收已准备的处理函数。
- `@ainess/http/request-signal` 提供 Node 服务端的 `getHttpRequestSignal()`。监听器为每个请求创建一个信号，连接提前关闭时触发，响应正常完成时清理监听器。相同 Node 运行环境中的适配器和已打包模块共享同一个请求异步上下文。请求上下文之外返回 `undefined`。
- Cordis 由宿主提供。包依赖 `@ainess/loader`、Koa、koa-compose、find-my-way 和 `@standard-schema/spec` 类型。运行根目录 `pnpm test` 验证真实请求、Controller 校验与目录装配、并发请求取消隔离、注册归属、启动回滚和关闭顺序。
