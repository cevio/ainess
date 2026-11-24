# Ainess 应用装配

以下示例可在安装技能的应用目录使用。应用依赖从已有的工作区或包源取得，并使用与 Ainess 兼容的 Cordis 版本。

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
