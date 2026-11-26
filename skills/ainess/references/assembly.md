# Ainess 应用装配

以下示例可在安装技能的应用目录使用。应用依赖从已有的工作区或包源取得。使用 Cordis 时，选择与 Ainess 兼容的版本。

## 运行 HTTP、Model 和 TypeORM

宿主提供 `@ainess/framework`、`@ainess/http`、`@ainess/model`、`@ainess/typeorm`、`@deepseek-ai/cordis`、`typeorm` 和 `sql.js`。通过命令启动时，在同一应用中安装 `@ainess/cli`。这组 `.mjs` 文件使用内存 SQLite 验证端到端请求。

在 `note-entity.mjs` 声明应用实体。

```js
import { EntitySchema } from 'typeorm'

export const note = new EntitySchema({
  name: 'Note',
  columns: {
    id: { type: Number, primary: true },
    text: { type: String },
  },
})
```

在 `models/notes.model.mjs` 定义领域。`find` 声明自己的数据库依赖，Schema 把字符串转成整数，并由调用方在入口执行一次。

```js
import { defineModel, defineModelOperation } from '@ainess/model'
import { note } from '../note-entity.mjs'

export default defineModel('notes', {
  find: defineModelOperation({
    schema: {
      '~standard': {
        version: 1,
        vendor: 'notes-example',
        validate(value) {
          if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
            const id = Number(value)
            if (Number.isSafeInteger(id)) return { value: id }
          }
          return { issues: [{ message: 'Expected a positive integer ID' }] }
        },
      },
    },
    inject: ['typeorm'],
    execute(id, { signal }, { typeorm }) {
      signal?.throwIfAborted()
      return typeorm.getRepository(note).findOneBy({ id })
    },
  }),
})
```

在 `controllers/notes/[id].controller.mjs` 装配 HTTP 方法。这个公开查询用例传入 `caller: null`。其他应用应从登录或服务身份取得方法要求的 `caller`。

```js
import { defineController } from '@ainess/http'
import { getHttpRequestSignal } from '@ainess/http/request-signal'

export default (ctx) => ({
  method: 'GET',
  middlewares: [defineController(async (request, { params }) => {
    const find = ctx.models.notes.find
    const parsed = await find.inputSchema['~standard'].validate(params.id)
    if (parsed.issues) return request.throw(400, 'Invalid note ID', { issues: parsed.issues })

    const note = await find(parsed.value, { caller: null, signal: getHttpRequestSignal() })
    if (!note) return request.throw(404, 'Note not found')
    return note
  })],
})
```

在 `ainess.config.mjs` 装配提供者、目录和入口。目录插件声明了 Controller 所需的方法，`seed` 初始化示例数据，框架会等 `plugins` 都就绪后再监听。

```js
import { defineApp, use } from '@ainess/framework'
import { http, httpListener } from '@ainess/http'
import { httpControllers } from '@ainess/http/controllers'
import { models } from '@ainess/model'
import { modelDirectory } from '@ainess/model/loader'
import { typeorm } from '@ainess/typeorm'
import { note } from './note-entity.mjs'

export default defineApp({
  plugins: {
    database: use(typeorm, { type: 'sqljs', entities: [note], synchronize: true }),
    models: use(models),
    notes: use(modelDirectory, { directory: new URL('./models/', import.meta.url) }),
    http: use(http),
    controllers: use(httpControllers({
      directory: new URL('./controllers/', import.meta.url),
      prefix: '/api',
      inject: ['models', 'models.notes', 'models.notes.find'],
    })),
    seed: use({
      inject: ['typeorm'],
      async apply(ctx) {
        await ctx.typeorm.getRepository(note).insert({ id: 1, text: 'Ainess' })
      },
    }),
  },
  entries: {
    web: use(httpListener, { host: '127.0.0.1', port: 3000 }),
  },
})
```

在应用目录运行 `pnpm exec ainess start`。CLI 读取 `ainess.config.mjs` 并启动框架应用。省略 `startupTimeoutMs` 时，应用持续等待插件和入口就绪。`GET /api/notes/1` 返回 `{"id":1,"text":"Ainess"}`，`GET /api/notes/bad` 返回 `400`，`GET /api/notes/2` 返回 `404`。用 `SIGINT` 或 `SIGTERM` 验证进程退出。程序入口也可调用 `const running = await app.start()` 并等待 `running.stop()`。

项目已有 Cordis 宿主时，将提供者和消费插件挂到现有 Context。等路由及依赖就绪再挂载监听器，先等待监听 Fiber 的 `dispose()`，再等待根 Fiber 的 `dispose()`。TypeORM 的事务从 `ctx.typeorm.transaction()` 或注入的 `typeorm.transaction()` 开始，事务内用回调的 manager 及其 repository。

## 加入 Next.js

宿主提供 `@ainess/http-next`、Next.js、React 和 React DOM。在配置中为现有入口增加 `prepare`。下面的 `dir` 指向应用自己的 Next.js 项目，`apiPrefix` 与上例的 Controller 路径一致。

```js
import { fileURLToPath } from 'node:url'
import { httpNext } from '@ainess/http-next'

const prepare = httpNext({
  dir: fileURLToPath(new URL('./web/', import.meta.url)),
  apiPrefix: '/api',
})
```

将 `prepare` 传入 `use(httpListener, { host: '127.0.0.1', port: 3000, prepare })`。`/api/...` 进入 Ainess，其他路径交给 Next.js。共享 Koa 链时设 `routing: 'koa-first'` 并省略 `apiPrefix`，把请求体解析限定在命中的 API 路由内。开发态运行 `NODE_ENV=development pnpm exec ainess start`，重启时关闭旧进程并启动新进程。生产先运行 `pnpm exec next build web`，再用 `NODE_ENV=production pnpm exec ainess start`。

当依赖安装在应用根、Next.js 项目位于 `web/` 时，可在 `web/next.config.mjs` 中设置 `turbopack.root` 为应用根的绝对路径。工作区内的链接依赖也需要位于编译根可解析的范围。 [Turbopack 根目录](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory)

## 加入 Redis

宿主提供 `@ainess/ioredis` 和 ioredis。从 `@ainess/ioredis` 导入 `ioredis`，在 `plugins` 中装配以下安装项之一。业务插件声明 `inject: ['ioredis']`，Model 方法也可以把该键加入自己的 `inject`。使用已有连接执行 `ping()` 等原生命令。

```js
import { ioredis } from '@ainess/ioredis'

const redis = use(ioredis, { host: '127.0.0.1', port: 6379 })
const redisCluster = use(ioredis, {
  startupNodes: [{ host: '127.0.0.1', port: 7000 }],
  clusterOptions: { scaleReads: 'master' },
})
```

用 Sentinel 时传原生 `sentinels` 与 `name`。Cluster 的节点级选项放到 `clusterOptions.redisOptions`，多键操作先确认槽位约束。工作区的 TypeORM 1.1.3 与 ioredis 同用时选择 ioredis 5.11.1 起的 5.x。对每个已配置的服务复用一个托管提供者，关闭时依赖方先完成清理。

TypeScript 应用使用 ioredis 6.1.0 且配置了 pnpm `hoist: false` 时，在宿主运行 `pnpm add -D @types/redis-errors`，供 ioredis 的公开错误声明解析。

## 为 Model 生成类型

TypeScript 应用用 `InferModel<typeof definition>` 扩展 `ModelTypes`，也可以在 `ainess.models.json` 使用 `{"sourceRoot":"src","runtimeRoot":"dist","directory":"models"}` 集中生成声明。Model 源文件保留 `*.model.ts` 或 `*.model.mts` 命名和默认导出。

1. 编译前用 `@ainess/model/typegen` 的 `prepareModelBuild(config)` 生成声明。将 `src/models.generated.d.ts` 纳入应用的 `tsconfig.json`。
2. TypeScript 编译成功后调用钩子返回的异步发布函数。它核对 Model 产物和当前声明再写入清单。部署时带上配置文件、编译产物和生成的 `dist/models/.ainess-models.json`。
3. 给 `modelDirectory` 传入指向同一配置的 `{ config }`。开发流程可用 `watchModelTypes(config, reportError)` 更新声明和清单，退出时等待返回的关闭函数。应用的编译工具和进程管理器负责更新运行产物和重启。

确保每个 Model 源文件对应唯一的运行时产物路径。比如默认配置下，同目录的 `notes.model.ts` 和 `notes.model.js` 都会映射到 `notes.model.js`，准备构建时会报冲突。

## 复用 Loader

开发其他目录插件时，复用扫描和导入。以下 `load-views.mjs` 会扫描 `views/` 中的 `*.view.mjs`，例如默认导出 `'home'` 的 `views/(public)/index.view.mjs`。

```js
import { importModules, parseFileRoute, scanModules } from '@ainess/loader'

const files = await scanModules({ directory: new URL('./views/', import.meta.url), suffix: 'view' })
const routes = files.map(({ stem, relativePath }) => parseFileRoute(stem, {
  prefix: '/preview',
  source: relativePath,
}))
const views = await importModules(files, (value) => {
  if (typeof value !== 'string') throw new TypeError('Expected a view name')
  return value
})

console.log(routes, views.map(({ value }) => value))
```

先用 `scanModules()` 得到排序后的文件记录，必要时在导入前统一校验路径。`importModules()` 执行模块并把默认导出交给解码器。消费插件管理注册、冲突回滚和卸载。无需预处理时可直接用 `loadModules(options, decode)`。HTTP Controller 的 `[...name]` 匹配非空剩余路径，更具体的通配没有剩余路径时，同一方法的上级通配仍可匹配。

## 接入 TCP RPC

宿主提供 `@ainess/rpc`、`@ainess/framework` 和 `@deepseek-ai/cordis`。以下 `rpc.mjs` 把 RPC 监听器装配为框架入口，通过 `ctx.effect()` 托管，由框架关闭。拨号端请求问候时，接入端通过同一条连接反向调用拨号端的方法。

```js
import { defineApp, use } from '@ainess/framework'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

/** @type {import('@ainess/rpc').RpcAddress | undefined} */
let address

const app = defineApp({
  entries: {
    rpc: use(async (ctx) => {
      await ctx.effect(async () => {
        const server = await RpcServer.listen({
          host: '127.0.0.1',
          port: 0,
          onPeer(peer) {
            peer.register({
              name: 'demo.greet',
              mode: RpcMode.Unary,
              handle: ({ peer, signal }) => peer.request('demo.message', { signal, timeoutMs: 5_000 }),
            })
          },
        })
        address = server.address
        return () => server.close()
      })
    }),
  },
})

const running = await app.start()
try {
  if (!address) throw new Error('RPC entry did not start')
  const peer = await RpcPeer.connect(address, {
    methods: [{
      name: 'demo.message',
      mode: RpcMode.Unary,
      handle: () => new TextEncoder().encode('hello'),
    }],
  })
  try {
    const reply = await peer.request('demo.greet', {
      timeoutMs: 5_000,
    })
    console.log(new TextDecoder().decode(reply))
  } finally {
    await peer.close()
  }
} finally {
  await running.stop()
}
```

运行 `node rpc.mjs` 会输出 `hello`。`app.start()` 等待 RPC 监听就绪。`RpcPeer.connect()` 先拨通 TCP，再在同一条连接上完成 RPC 握手。监听端在分派首个入站调用前执行 `onPeer`。问候处理函数通过上下文的 `peer` 反向调用 `demo.message`，并用 `signal` 传递取消信号。长期使用的端点由其调用方或创建它的插件复用并在退出时关闭。 [同连接反向调用与双向流](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#快速开始)

插件若维护活跃连接表，可在 `onPeer` 中记录端点，并用 `peer.onClose(() => { peers.delete(peer) })` 在关闭时移除。拨号端可以用同一个接口接收异步关闭通知，按 `reason` 处理本端关闭、对端正常关闭和错误，并在应用层安排重连。 [连接保活和关闭通知](https://github.com/cevio/ainess/blob/main/packages/rpc/README.md#连接保活和关闭通知)

## 通过 Registry 发现服务

宿主提供 `@ainess/registry-server`、`@ainess/registry-client`、`@ainess/rpc`、`@ainess/framework` 和 `@deepseek-ai/cordis`。将下例保存为 `registry.mjs`，用 `node registry.mjs` 验证业务 RPC 直连。

```js
import { defineApp, use } from '@ainess/framework'
import { RegistryClient, registry } from '@ainess/registry-client'
import { registryServer } from '@ainess/registry-server'
import { RpcMode, RpcPeer, RpcServer } from '@ainess/rpc'

const host = '127.0.0.1'
const directory = await defineApp({
  entries: { registryServer: use(registryServer, { host, port: 0 }) },
}).start()

let provider
let publisher
let consumer
let peer
try {
  const address = directory.ctx.registryServer.address
  provider = await RpcServer.listen({
    host,
    port: 0,
    methods: [{
      name: 'orders.health',
      mode: RpcMode.Unary,
      handle: () => new TextEncoder().encode('ready'),
    }],
  })
  publisher = await RegistryClient.connect(address)
  await publisher.discovery.register({ ...provider.address, services: ['orders'] })

  consumer = await defineApp({ plugins: { registry: use(registry, { address }) } }).start()
  const endpoint = await consumer.ctx.registryClient.discovery.pick({ service: 'orders' })
  if (!endpoint) throw new Error('No address registered for orders')

  peer = await RpcPeer.connect(endpoint)
  const reply = await peer.request('orders.health', { timeoutMs: 5_000 })
  console.log(new TextDecoder().decode(reply))
} finally {
  await peer?.close()
  await consumer?.stop()
  await publisher?.close()
  await provider?.close()
  await directory.stop()
}
```

示例输出 `ready`。部署时将 Registry、服务提供方和调用方置于各自的进程，给 Registry 客户端配置可拨号的 Registry 地址，并在提供方登记调用方可访问的业务地址。`pick()` 只选址，业务连接由调用方持有和关闭。重复发起业务请求时可以复用已经建立的 `RpcPeer`。

再次选址时可用 `discovery.pick({ service: 'orders', exclude: [endpoint] })` 跳过已知地址。排除按主机名和端口精确匹配，只作用于这次选址。无可选实例时返回 `null`。

一个业务监听器可通过 `services` 登记多个服务。业务计划下线时，可以先调用 `unregister({ services, host, port })` 撤销相应登记，再关闭监听器。关闭 Registry 客户端也会让服务端清理该控制连接的登记。应用托管的 `registry` 和 `registryServer` 插件均随 `running.stop()` 关闭。 [服务端手册](https://github.com/cevio/ainess/blob/main/packages/registry-server/README.md) · [客户端手册](https://github.com/cevio/ainess/blob/main/packages/registry-client/README.md)

## 通过 Micro 调用已登记服务

宿主提供 `@ainess/framework`、`@deepseek-ai/cordis`、`@ainess/registry-server`、`@ainess/registry-client`、`@ainess/rpc` 和 `@ainess/micro`。将下例保存为 `micro-registry.mjs`，运行 `node micro-registry.mjs`。

```js
import { defineApp, use } from '@ainess/framework'
import { micro } from '@ainess/micro'
import { registry } from '@ainess/registry-client'
import { RegistryServer } from '@ainess/registry-server'
import { RpcMode, RpcServer } from '@ainess/rpc'

const host = '127.0.0.1'
const directory = await RegistryServer.listen({ host, port: 0 })
const address = directory.address
let provider
let consumer

try {
  provider = await defineApp({
    plugins: { registry: use(registry, { address }) },
    entries: {
      orders: use({
        inject: ['registryClient'],
        /** @param {import('@deepseek-ai/cordis').Context} ctx */
        async apply(ctx) {
          const discovery = ctx.registryClient.discovery
          await ctx.effect(async () => {
            const server = await RpcServer.listen({
              host,
              port: 0,
              methods: [{ name: 'orders.echo', mode: RpcMode.Unary, handle: ({ data }) => data }],
            })
            const registration = { ...server.address, services: ['orders'] }
            try {
              await discovery.register(registration)
            } catch (error) {
              await server.close()
              throw error
            }
            return async () => {
              try {
                await discovery.unregister(registration)
              } finally {
                await server.close()
              }
            }
          })
        },
      }),
    },
  }).start()

  const running = await defineApp({
    plugins: {
      registry: use(registry, { address }),
      micro: use({
        inject: ['registryClient'],
        /** @param {import('@deepseek-ai/cordis').Context} ctx */
        apply(ctx) {
          return micro(ctx, { discovery: ctx.registryClient.discovery })
        },
      }),
    },
  }).start()
  consumer = running

  const replies = await Promise.all(['first', 'second'].map(value =>
    running.ctx.micro.request('orders', 'orders.echo', new TextEncoder().encode(value)),
  ))
  console.log(replies.map(reply => new TextDecoder().decode(reply)))
} finally {
  try {
    await Promise.all([consumer?.stop(), provider?.stop()])
  } finally {
    await directory.close()
  }
}
```

示例输出 `['first', 'second']`。提供方在业务监听就绪后登记地址，停机时注销并关闭监听器。调用方的两个请求共用首次选址和拨号，各自独立发送 RPC。业务连接由 `micro` 管理，控制连接由 `registry` 管理。应用也可直接传入满足 `MicroDiscovery.pick()` 契约的其他发现实现。 [Micro 手册](https://github.com/cevio/ainess/blob/main/packages/micro/README.md)

Micro 默认对持续失败的服务实例熔断。打开熔断后优先复用同服务其他实例的连接，需要发现时向 `pick()` 传 `exclude`。业务调用发出后由调用方消费结果或错误。应用可以在示例的 `micro(ctx, options)` 中传入 `circuitBreaker` 配置。 [熔断选项](https://github.com/cevio/ainess/blob/main/packages/micro/README.md#业务熔断)
