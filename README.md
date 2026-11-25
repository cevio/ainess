# Ainess

Ainess 是一个基于 `@deepseek-ai/cordis` 的 TypeScript ESM monorepo。Cordis 的 `Context` 负责插件组合，`Service` 提供具名服务，`Fiber` 管理插件启动和清理。[Cordis 服务文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/03-services.md)、[生命周期文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-tutorial/02-lifecycle-and-effects.md)

## 包索引

| 包 | 用途 |
| --- | --- |
| [@ainess/framework](packages/framework/README.md) | 装配 Cordis 应用并管理启动、回滚与清理。 |
| [@ainess/cli](packages/cli/README.md) | 通过 `ainess` 命令加载配置、启动应用及处理退出信号。 |
| [@ainess/http](packages/http/README.md) | 接入 Koa 中间件、路由、Controller 及监听器。 |
| [@ainess/http-next](packages/http-next/README.md) | 通过同一监听器提供 Ainess API 和 Next.js 页面。 |
| [@ainess/model](packages/model/README.md) | 定义、加载和调用类型化领域方法，生成声明和构建清单。 |
| [@ainess/typeorm](packages/typeorm/README.md) | 注入原生 TypeORM 数据源。 |
| [@ainess/ioredis](packages/ioredis/README.md) | 注入原生 Redis 单节点、Sentinel 或 Cluster 客户端。 |
| [@ainess/loader](packages/loader/README.md) | 在消费包中复用模块扫描、导入与文件路由解析。 |
| [@ainess/rpc](packages/rpc/README.md) | 在同一 TCP 长连接两端发起和处理单响应或流式 RPC，支持运行时注册和注销。[单连接性能实测](packages/rpc/README.md#单连接性能实测) |

仓库内的 AI 开发入口见 [`llms.txt`](llms.txt)。

## 本地验证

使用 Node.js 22.x（最低 22.13）或 24.11 及以上版本，以及 pnpm 12.23.0。

```bash
pnpm install
pnpm test
```

`pnpm test` 构建工作区、检查测试类型，并运行真实 HTTP、Next.js、TCP RPC 与内存 SQLite 测试。本机有支持 Unix socket 的 `redis-server` 时，测试会验证 Redis 单节点的读写、重连和关闭顺序。同时装有 `redis-cli` 时，还会用三个 Redis 主节点验证集群路由。

## 通过配置启动

应用安装 `@ainess/framework`、`@deepseek-ai/cordis` 和 `@ainess/http`，在 `ainess.config.mjs` 声明装配项。用命令行启动时还需安装 `@ainess/cli`。下面的应用从编译目录加载 Controller，完成路由注册后监听 HTTP。

```js
import { defineApp, use } from '@ainess/framework'
import { http, httpListener } from '@ainess/http'
import { httpControllers } from '@ainess/http/controllers'

export default defineApp({
  plugins: {
    http: use(http),
    controllers: use(httpControllers({
      directory: new URL('./dist/controllers/', import.meta.url),
      prefix: '/api',
    })),
  },
  entries: {
    web: use(httpListener, { host: '127.0.0.1', port: 3000 }),
  },
})
```

将下面的 Controller 编译到 `dist/controllers/index.controller.mjs`，也可直接把这个文件放到该位置试用。

```js
import { defineController } from '@ainess/http'

export default () => ({
  method: 'GET',
  middlewares: [defineController(() => ({ ok: true }))],
})
```

在应用目录运行 `pnpm exec ainess start`，请求 `http://127.0.0.1:3000/api` 应得到 `{"ok":true}`。`--config` 可指定其他 ESM 配置文件，例如 `./dist/ainess.config.js`。运行 `pnpm exec ainess start --help` 查看启动选项。程序内可导入同一份配置，调用 `await app.start()`，并在结束时调用返回实例的 `await running.stop()`。 [CLI 手册](packages/cli/README.md)

`use()` 使用原生 Cordis 插件及其配置。所有 `plugins` 激活后，应用才挂载 `entries`，并等待全部入口激活后报告启动成功。省略 `startupTimeoutMs` 时持续等待就绪。关闭时入口先排空，根 Context 再释放服务。 [应用装配与生命周期](packages/framework/README.md)

## 组合使用

- Controller 可以把校验后的输入交给 Model，Model 方法通过自己的 `inject` 获取 TypeORM 或其他业务依赖。 [HTTP 调用 Model](packages/model/README.md#从-http-调用-model)
- 需要同一个端口提供 API 和页面时，在当前的 `httpListener` 入口传入 `prepare: httpNext(...)`，并按项目需要选择前缀分流或共享 Koa 中间件。 [Next.js 装配示例](packages/http-next/README.md#快速开始)
- 应用可以用 `RpcServer` 监听端口，用 `RpcPeer` 建立 TCP RPC 连接。连接两端都能调用对方的方法。Cordis 应用可由创建连接的插件托管其生命周期。 [同连接反向调用](packages/rpc/README.md#快速开始) · [Cordis 装配示例](skills/ainess/references/assembly.md#接入-tcp-rpc)

## 安装 Agent 技能

在使用 Ainess 的项目中，从包含 `skills/ainess/` 的仓库版本安装 `ainess` 技能。Skills CLI 需要 Node.js 22.20 或以上版本。 [Skills CLI 要求](https://github.com/vercel-labs/skills#install-a-skill)

```sh
npx skills add cevio/ainess --skill ainess
```

测试本地版本时，将 `cevio/ainess` 换成 Ainess 仓库的本地路径。技能说明各包用法、包间关系和注意事项，并附可运行的应用示例。 [技能源码](skills/ainess/SKILL.md) · [Skills CLI 安装说明](https://github.com/vercel-labs/skills/blob/main/docs/commands.md#skills-add)
