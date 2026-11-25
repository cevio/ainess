---
name: ainess
description: 使用、组合和验证 Ainess 的公开能力。用于使用 @ainess/* 的应用、编写 ainess.config、装配 Cordis 服务与入口、用 CLI 启停应用、接入 HTTP Controller、Next.js、Model、TypeORM、Redis 或 TCP RPC，以及复用目录加载能力。
---

# 使用 Ainess

用 Ainess 组装 TypeScript ESM 应用。先读目标项目的指引和依赖。使用 Cordis 时，确认应用通过 `ainess.config` 还是直接用 Cordis 装配。使用项目声明的 Ainess 和宿主库版本，从包的公开入口导入。

## 包之间如何配合

- **启动**。应用选择 `framework` 或直接使用 Cordis。在启动 `httpListener` 前，等待选定的 `http`、`models`、数据库和 Redis 等服务，以及 Controller 和领域方法装配。`framework` 按 `plugins` 和 `entries` 两阶段执行。通过命令启动框架应用时，由 `cli` 加载配置并调用框架的生命周期接口。
- **请求**。`httpListener` 把 API 请求交给 `http`。Controller 校验外部输入，通过声明的注入键调用 Model。Model 方法按需注入 `typeorm` 或 `ioredis`，并复用对应的客户端。需要 Next.js 时，用 `http-next` 在同一个监听器上把页面请求交给 Next.js。
- **目录**。`http/controllers` 和 `model/loader` 复用 `loader` 扫描和导入文件，由各自的插件处理业务定义、注册和卸载。应用可选择显式注册或使用对应的目录插件。
- **关闭**。先停止入口并等在途响应，接着卸载消费方和领域方法，最后关闭其依赖的数据库与 Redis。独立 Cordis 宿主负责按这个顺序等待 Fiber，框架应用调用 `running.stop()`。

完整的请求链示例随技能安装。 [HTTP → Model → SQLite 装配](references/assembly.md)

## 各包怎么用

### `@ainess/framework`

在应用的 ESM 配置中默认导出 `defineApp({ plugins, entries })`，各项用 `use(plugin, options)` 包装原生 Cordis 插件。提供者、Model 和路由注册放在 `plugins`，监听器放在 `entries`。同组依赖通过 `inject` 声明。用 `app.start({ signal })` 等待就绪，可通过 `signal` 取消等待。省略 `startupTimeoutMs` 时持续等待就绪。启动取消或失败会清理已挂载的资源，关闭已启动实例用 `await running.stop()`。 [framework 手册](https://github.com/cevio/ainess/blob/main/packages/framework/README.md)

### `@ainess/cli`

在框架应用中安装 CLI，再用 `pnpm exec ainess start` 启动。它从工作目录加载 `ainess.config.mjs`，可用 `--config <file>` 指定另一个 ESM 文件，用 `pnpm exec ainess start --help` 查看选项。配置默认导出框架应用定义。收到 `SIGINT` 或 `SIGTERM` 时，CLI 取消启动或等待已启动应用清理。生产部署使用该命令时，把 CLI 声明为应用的运行时依赖。 [CLI 手册](https://github.com/cevio/ainess/blob/main/packages/cli/README.md)

### `@ainess/http`

安装 `http`，业务插件声明 `inject: ['http']` 就能用 `ctx.http.use()` 和 `ctx.http.route()`。使用 `defineController({ schema, handle })` 时，`handle` 的第二个参数已经校验，`body` 由前置 Koa 中间件解析。少量或动态路由用显式注册，文件式路由用 `@ainess/http/controllers` 的 `httpControllers({ directory, prefix, inject })`。待路由装配后启动 `httpListener`，客户端断开时从 `@ainess/http/request-signal` 取信号传给支持取消的下游。使用 Next.js 回退时，在命中的 API 路由内解析请求体。 [HTTP 手册](https://github.com/cevio/ainess/blob/main/packages/http/README.md)

### `@ainess/http-next`

应用提供 Next.js、React 和 React DOM。用 `httpNext({ dir, apiPrefix: '/-' })` 产生 `httpListener` 的 `prepare`，API 注册完整路径 `/-/...`。前缀分流让页面直接进入 Next.js。页面需要共享 Koa 链时，用 `routing: 'koa-first'` 并省略 `apiPrefix`，只有尚未响应且请求流仍可用的未匹配请求会回退 Next.js。确认 Next.js 编译根能解析宿主依赖。生产先构建 Next 项目，开发态关闭旧进程后在新进程重启。 [Next.js 接入步骤](references/assembly.md#加入-nextjs) · [Next.js 手册](https://github.com/cevio/ainess/blob/main/packages/http-next/README.md)

### `@ainess/model`

安装 `models` 后，用 `defineModel('orders', { ... })` 组织由 `defineModelOperation({ schema, inject, execute })` 声明的领域方法。显式用 `ctx.models.register(definition)`，或用 `@ainess/model/loader` 的 `modelDirectory` 扫描默认导出的 `*.model.js`、`*.model.mjs`。消费插件声明 `models`、`models.orders` 和所需的 `models.orders.<方法>`，在入口用方法的 `inputSchema` 校验，再传入解析结果与 `{ caller, signal }`。每个方法独立等待自己的依赖。跨卸载使用当前注入服务，避免保留旧引用。类型由 `InferModel` 扩展 `ModelTypes`，目录应用可用 `@ainess/model/typegen` 生成。 [类型生成接入](references/assembly.md#为-model-生成类型) · [Model 手册](https://github.com/cevio/ainess/blob/main/packages/model/README.md)

### `@ainess/typeorm`

宿主提供 TypeORM、所用驱动、实体和 `DataSourceOptions`。在 `plugins` 用 `use(typeorm, options)` 安装，消费者声明 `inject: ['typeorm']`，通过原生 `ctx.typeorm` 取 repository。Model 方法把 `typeorm` 写在自己的 `inject` 中，通过 `execute()` 的第三个参数使用。事务内使用回调的 manager。每个隔离作用域复用其活动数据源，由提供者初始化和关闭。 [TypeORM 手册](https://github.com/cevio/ainess/blob/main/packages/typeorm/README.md)

### `@ainess/ioredis`

宿主提供兼容的 ioredis 版本。用 `use(ioredis, options)` 安装，消费者声明 `inject: ['ioredis']` 并复用 `ctx.ioredis`。单节点或 Sentinel 直接传 `RedisOptions`。Cluster 使用 `{ startupNodes, clusterOptions }`，节点认证和 TLS 配置放入 `clusterOptions.redisOptions`。集群多键命令所用的键应在同一槽位。首次连接失败由启动任务报告，运行期按原生 ioredis 策略重连，关闭归提供者。 [Redis 装配选项](references/assembly.md#加入-redis) · [ioredis 手册](https://github.com/cevio/ainess/blob/main/packages/ioredis/README.md)

### `@ainess/loader`

需要新模块类型或文件路由时，用 `scanModules({ directory, suffix, extensions })` 取有序文件清单，用 `parseFileRoute(stem, { prefix, source })` 解析路径，再用 `importModules(files, decode, signal?)` 导入和校验选中的默认导出。只需要全部扫描和导入时使用 `loadModules()`。先校验可从文件路径判断的错误，再执行模块。消费方负责业务注册、取消及资源清理。 [复用 Loader](references/assembly.md#复用-loader) · [loader 手册](https://github.com/cevio/ainess/blob/main/packages/loader/README.md)

### `@ainess/rpc`

用 `RpcServer.listen({ host, port, onPeer })` 开始监听，用 `RpcPeer.connect({ host, port }, { methods })` 建连并等待握手。拨号和接入的两端共享一条 TCP 连接，都可发起和处理调用。监听端在 `onPeer` 取得接入端点，处理函数通过上下文的 `peer` 发起同连接反向调用。用 `peer.register()` 注册连接专属方法，用 `server.register()` 注册监听器共享方法。连接专属方法优先于同名共享方法。返回的注销函数立即移除该注册，并等待它已接收的调用清理。任一端可用 `request(name, options?)` 接收单响应，用 `stream(name, options?)` 接收流。发送初始数据时，在方法名和选项之间传入 `Uint8Array`。提供 `options.input` 开启上传流，上传源应响应自己的 `AbortSignal`。处理方可通过 `input.stop()` 只停止上传方向。业务对象由应用编解码，结束时等待端点和监听器的 `close()`。 [Cordis 装配示例](references/assembly.md#接入-tcp-rpc) · [RPC 手册](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md)

## 开发和验证

1. 核对当前版本的依赖、公开入口和类型。Ainess 源码检出内读根 `llms.txt`、包级 `AGENTS.md` 和手册。使用外部项目时优先查实际安装的包或同版本源码。 [文档索引](https://github.com/cevio/ainess/blob/main/llms.txt)
2. 复用现成插件、客户端和 Schema。Controller 目录和 Model 方法用服务名数组声明 `inject`，例如 `['typeorm']`。在信任边界校验输入，创建资源的插件用 `ctx.effect()` 注册清理。新增调用时确认服务键就绪、作用域归属及取消传播。
3. 从实际入口验证正常请求和涉及的失败路径。资源相关改动同时验证启动、清理和退出顺序。Ainess 仓库运行 `pnpm test` 与包手册指定的集成验证，应用项目执行自己的测试和启动命令。
