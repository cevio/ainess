# @ainess/http

宿主提供 `@deepseek-ai/cordis`。安装 `http` 后，业务插件声明 `inject: ['http']`，用 `ctx.http.use()` 注册共享的 Koa 中间件，用 `ctx.http.route()` 注册显式路由。中间件和路由随注册它们的 Fiber 清理。`defineController({ schema, handle })` 在调用 `handle` 前校验一次输入，失败返回 `400`。`body` 由前置 Koa 中间件解析。 [HTTP 手册](https://github.com/cevio/ainess/blob/main/packages/http/README.md) · [显式路由示例](framework.md#声明应用)

文件式路由使用 `@ainess/http/controllers` 的 `httpControllers({ directory, prefix, inject })`。默认加载 `*.controller.js` 和 `*.controller.mjs`，文件默认导出接收 Context 的同步工厂。插件自动注入 `http`，其他依赖通过 `inject` 声明。在已有插件内加载时，声明所需依赖并等待 `loadHttpControllers(ctx, options)`。文件路径解析由 Loader 提供，本批注册冲突由目录插件回滚。 [文件路由](loader.md)

文件名中的 `[name]` 表示路径参数，末尾 `[...name]` 匹配非空剩余路径。更具体的通配路由没有剩余路径时，同一 HTTP 方法的上级通配仍可匹配。

等路由装配后再启动 `httpListener`，用 `ctx.http.address()` 取得实际监听地址。来自 `@ainess/http/request-signal` 的 `getHttpRequestSignal()` 会在客户端提前断开时中止。在请求内将信号传给支持取消的下游。使用 Next.js 回退时，在命中的 API 路由内解析请求体。 [Next.js 分流与关闭](http-next.md)

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

项目已有 Cordis 宿主时，将提供者和消费插件挂到现有 Context。等路由及依赖就绪再挂载监听器，先等待监听 Fiber 的 `dispose()`，再等待根 Fiber 的 `dispose()`。 [CLI 启停](cli.md) · [Model 声明与类型生成](model.md) · [TypeORM 事务](typeorm.md)
