# @ainess/http-next 开发指引

共享监听器、分流和重启用法见[使用手册](README.md)。

- `httpNext({ dir, dev, apiPrefix })` 为 `@ainess/http` 的 `httpListener` 提供监听前适配器。应用选择 API 前缀，并以完整路径注册 Ainess 路由。前缀按请求目标中的原始路径段匹配，Ainess 与 Next.js 使用同一个 Node HTTP Server。
- `httpNext({ dir, dev, routing: 'koa-first' })` 让请求先完成共享 Koa 链。`apiPrefix` 只适用于前缀分流，在 `koa-first` 配置中提供会抛出错误。HTTP 路由未命中、响应尚未被业务接管且请求流可转交时，由同一监听器交给 Next.js。Controller 或中间件主动产生的 404 由 Koa 响应。请求体解析可以放在各自匹配的路由内。
- Next.js 收到原生请求和响应，管理项目配置、App Router、RSC、Server Actions、静态资源和开发态 HMR。应用在生产环境先执行 `next build`，再运行 Cordis 入口。
- Node 运行时的 Server Component 和 Route Handler 可通过 `@ainess/http/request-signal` 读取监听器管理的请求信号，并传给支持取消的下游调用。集成测试验证组件读取信号和流式响应断开后的取消。
- 适配器等待 `next.prepare()`，在失败时回收 Next runtime。正常卸载由监听 Fiber 排空并关闭连接，再调用适配器的清理函数。
- 适配器使用 `@ainess/http` 的公开契约，Next.js、React 和 React DOM 由宿主提供。根目录 `pnpm test` 用真实 Next 开发项目验证两种分流方式、资源、Server Action 和 HMR 清理。
- 两种分流方式的集成测试在独立进程中依次使用同一夹具，兼顾开发构建锁和 Next.js 生产渲染实例的目录级缓存。构建夹具后可设置 `AINESS_TEST_NEXT_PRODUCTION=1` 运行生产集成测试。
- 工作区使用原版 Next.js 16.4.6。开发编译器持有进程级原生资源，开发入口在 Fiber 清理完成后结束进程，重启时在新进程中创建 Next 实例。集成测试验证 HMR 连接关闭，以及新进程复用同一端口后仍能提供 HTTP API 和 RSC。
