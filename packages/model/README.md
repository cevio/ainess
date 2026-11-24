# @ainess/model

把领域方法注册为可注入的 Cordis 服务。入口负责解析和校验外部数据，Model 实现业务策略，方法自己的 `inject` 决定它何时可用。宿主依赖 `@ainess/model` 和工作区所用的 `@deepseek-ai/cordis`，输入契约使用 Standard Schema。使用应用已有的 Schema 库即可。 [Standard Schema](https://standardschema.dev/)

## 快速开始

下面用一个 Model 演示输入解析、调用者类型和资源清理。应用使用 ESM（`package.json` 中的 `"type": "module"`），为 TypeScript 示例安装 `typescript`、`@types/node` 和 `@standard-schema/spec`。在 `tsconfig.json` 中采用 `NodeNext` 和严格模式，设置 `types` 为 `['node']`、`rootDir` 为 `src`、`outDir` 为 `dist`，把 `src` 纳入 `include`。

将领域定义留在 `src/models/greetings.model.ts`。这个独立示例内联了一个把输入修剪成字符串的 Schema。

```ts
import { defineModel, defineModelOperation, type ModelCall } from '@ainess/model'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const nameSchema: StandardSchemaV1<unknown, string> = {
  '~standard': {
    version: 1,
    vendor: 'example',
    validate(value) {
      if (typeof value === 'string' && value.trim()) return { value: value.trim() }
      return { issues: [{ message: 'Expected a non-empty name' }] }
    },
  },
}

export default defineModel('greetings', {
  hello: defineModelOperation({
    schema: nameSchema,
    execute(name, { caller }: ModelCall<{ salutation: string }>) {
      return `${caller.salutation}, ${name}!`
    },
  }),
})
```

将下面内容保存为 `src/app.ts`。运行 `pnpm exec tsc -p tsconfig.json` 后执行 `node dist/app.js`，应输出 `Hello, Ada!`。

```ts
import { models, type InferModel } from '@ainess/model'
import { Context } from '@deepseek-ai/cordis'
import greetings from './models/greetings.model.js'

declare module '@ainess/model' {
  interface ModelTypes {
    greetings: InferModel<typeof greetings>
  }
}

const app = new Context()
try {
  await app.plugin(models).await()
  await app.plugin({
    inject: ['models'],
    async apply(ctx) {
      const registration = ctx.models.register(greetings)
      await registration.fiber.await()
    },
  }).await()

  await app.plugin({
    inject: ['models', 'models.greetings', 'models.greetings.hello'],
    async apply(ctx) {
      const hello = ctx.models.greetings.hello
      const parsed = await hello.inputSchema['~standard'].validate(' Ada ')
      if (parsed.issues) throw new TypeError('Invalid greeting input')
      console.log(await hello(parsed.value, { caller: { salutation: 'Hello' } }))
    },
  }).await()
} finally {
  await app.fiber.dispose()
}
```

## 定义和调用

| `@ainess/model` 接口 | 契约 |
| --- | --- |
| `models` | Cordis 插件，提供 `ctx.models`。消费注册器的插件声明 `inject: ['models']`。 |
| `defineModel(name, methods)` | 返回只读 `ModelDefinition`，包含领域 `name` 和 `methods`。方法必须是自有字符串键，值由 `defineModelOperation()` 创建。领域和方法名必须非空，避开点号和保留服务名。 |
| `defineModelOperation({ schema, inject?, execute })` | 返回 `ModelOperationDefinition`。`schema` 提供 Standard Schema，`inject` 接受非空服务名字符串组成的数组，默认 `[]`。`execute` 可同步或异步。声明时检查三者的形态。 |
| `ModelTypes` 和 `InferModel<typeof definition>` | 扩展 Model 命名空间的类型。少量显式注册可手动扩展，目录装配可由类型生成钩子集中维护。 |
| `ModelRegistry` 与 `ModelRegistration` | `ctx.models.register(definition)` 接收与 `ModelTypes` 对应的定义，返回 `{ name, fiber }`。`ctx.models.unregister(registration)` 异步卸载该句柄的领域。 |
| `ModelOperation<Schema, Caller, Output>` | 已就绪的方法签名为 `(input, call) => Promise<Output>`，`input` 是 Schema 解析后的输出类型。`operation.inputSchema` 提供该 Schema。 |
| `ModelCall<Caller>` | 提供类型化的 `caller` 和可选 `signal`。调用方从信任边界确定调用者，方法把信号交给支持取消的工作。 |

`execute(input, call, dependencies)` 的第三个参数只包含方法声明的服务。比如 `inject: ['typeorm']` 的方法通过 `dependencies.typeorm` 使用数据源。只在部分注入分支出现的服务，在类型上是可选属性。业务代码可直接返回结果或抛错，调用方处理对应的返回值或 Promise 拒绝。方法通过注入的 `models` 调用其他领域而出现循环类型推导时，给产生循环的方法显式标注 `execute()` 返回类型。

消费插件声明 `models`、`models.<领域>` 和它实际调用的 `models.<领域>.<方法>`。注册得到领域 Fiber，领域及各方法可有不同的就绪时刻。只有本方法所需的服务都可用时，依赖这个方法的消费插件才激活。一个方法缺少数据库等依赖时，同一领域中依赖已满足的方法仍可用。参见 [HTTP 与数据库的实际注入](test/model.test.js) 和 [依赖类型用例](test/inference.ts)。

领域名在同一注册作用域内唯一。领域注册归调用方 Fiber，卸载调用方会回收所属领域。要单独卸载，保存并传回原注册句柄。方法离开就绪状态后拒绝新调用，清理等待已接收的任务结束。依赖恢复会生成新的方法引用，消费者在自己的就绪作用域内使用当前服务，避免跨卸载缓存方法。`signal` 由方法或下游协作处理。

## 从 HTTP 调用 Model

在快速开始的应用中安装 `http`，用下列路由插件替换示例的调用插件，然后挂载 `httpListener`。Controller 将路径参数映射成领域输入，在边界使用方法的 `inputSchema` 校验一次，已解析的值直接传给方法。加数据库操作时，在方法的 `inject` 中声明 `typeorm`，由配置安装提供者。 [HTTP 监听与注入](../http/README.md) · [TypeORM 事务](../typeorm/README.md)

```ts
import { defineController } from '@ainess/http'
import { getHttpRequestSignal } from '@ainess/http/request-signal'

await app.plugin({
  inject: ['http', 'models', 'models.greetings', 'models.greetings.hello'],
  apply(ctx) {
    ctx.http.route('GET', '/greetings/:name', defineController(async (request, { params }) => {
      const hello = ctx.models.greetings.hello
      const parsed = await hello.inputSchema['~standard'].validate(params.name)
      if (parsed.issues) return request.throw(400, 'Invalid name', { issues: parsed.issues })
      const text = await hello(parsed.value, {
        caller: { salutation: 'Hello' },
        signal: getHttpRequestSignal(),
      })
      return { text }
    }))
  },
}).await()
```

## 按目录装配

每个 `*.model.js` 或 `*.model.mjs` 模块默认导出 `defineModel()` 的返回值，领域名由定义提供。把目录工作交给 `@ainess/model/loader`。

| 入口 | 使用场景 |
| --- | --- |
| `modelDirectory` | Cordis 插件，自动注入 `models`，等待加载完成。应用配置可在 `plugins` 中使用 `use(models)` 和 `use(modelDirectory, options)`。 |
| `loadModels(ctx, options): Promise<readonly ModelRegistration<string>[]>` | 已有装配插件时，在注入 `models` 的 `apply()` 中等待它。需要按句柄单独卸载时，使用其返回值。 |
| `ModelLoaderOptions` | 接受 `{ directory, extensions?, allowMissing? }` 或 `{ config }`。路径可以是字符串或 `file:` URL。 |

直接目录方式以工作目录解析相对字符串，扩展名默认 `['.js', '.mjs']`，启用 `allowMissing: true` 时尚未创建的目录按空目录处理。已有编译流程的应用可把快速开始中的手动注册插件替换成以下调用。

```ts
import { modelDirectory } from '@ainess/model/loader'

await app.plugin(modelDirectory, { directory: new URL('./models/', import.meta.url) }).await()
```

目录装配先核对默认导出与批内重名，再逐个注册领域。遇到错误会报告来源文件并撤销本次注册。装配期间卸载调用方或失去所需服务时，等待当前任务并跳过后续导入及注册，撤销已注册的部分。成功后领域由装配插件的 Fiber 管理。使用 [`@ainess/loader`](../loader/README.md) 的 ESM 导入语义，资源初始化适合放在 Cordis 提供者中。

## 类型生成与构建

应用可让类型生成和运行时目录装配共享一份 `ainess.models.json`。以下是默认目录布局，等价于配置 `{}`。

```json
{
  "sourceRoot": "src",
  "runtimeRoot": "dist",
  "directory": "models"
}
```

| 配置项 | 默认及解析规则 |
| --- | --- |
| `sourceRoot` 与 `runtimeRoot` | `src` 和 `dist`，相对配置文件所在目录解析。源码根须已存在，Model 子目录可暂时为空或缺失。 |
| `directory` | `models`，源码根和运行时根共用的相对子目录，须位于各自根内。 |
| `declaration` | `models.generated.d.ts`，相对源码根解析。将输出纳入应用的 `tsconfig.json`。 |
| `sourceExtensions` | `['.ts', '.mts', '.js', '.mjs']`，控制符合 `*.model.*` 的源码扫描。 |
| `runtimeExtensions` | `['.js', '.mjs']`，控制运行时产物。要识别 `.cts` 和 `.cjs`，分别把这两个后缀加入源码和运行时列表，并确保 ESM 导入获得的默认导出就是 Model 定义。宿主直接运行 TypeScript 时可选择允许的源码扩展名。 |

`@ainess/model/typegen` 提供两个异步钩子，均以配置的字符串路径或 `file:` URL 为参数。

- `prepareModelBuild(config)` 从源码路径生成声明，返回异步发布函数。生成过程使用静态类型引用。编译成功后，发布函数会检查预期的 Model 产物都存在、声明与准备时一致，再写入 `.ainess-models.json`。检查失败时保留现有清单，补齐缺失产物后可重试发布。声明和清单使用同一次源码扫描的结果。
- `watchModelTypes(config, reportError?)` 监听 Model 文件变动，返回前写入首份声明和运行清单。后续生成串行执行，错误默认交给 `console.error`。它返回异步关闭函数，应在开发进程或插件退出时等待。应用负责源码编译、提供清单所指产物和安排运行时重启。

对于快速开始的示例，删除 `src/app.ts` 中的手动 `ModelTypes` 扩展及其专用导入，将注册插件换成 `modelDirectory`，传入 `config: new URL('../ainess.models.json', import.meta.url)`。在应用根目录保存以下 `build.mjs`，执行 `node build.mjs`，再执行 `node dist/app.js`。

```js
import { execFileSync } from 'node:child_process'
import { prepareModelBuild } from '@ainess/model/typegen'

const project = new URL('./', import.meta.url)
const publish = await prepareModelBuild(new URL('./ainess.models.json', project))
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: project, stdio: 'inherit' })
await publish()
```

部署时同时带上 JSON 配置和完整的编译目录，包括 `dist/models/.ainess-models.json`。配置式 loader 根据清单选取文件，识别缺失的编译产物，并跳过编译目录中未列入本次清单的旧文件。清单尚不存在时按运行时目录扫描。TypeScript 的 `.ts`、`.mts`、`.cts` 优先映射到允许的 `.js`、`.mjs`、`.cjs`。对于 `.cts` Model，用 `export =` 导出定义，使加载器收到原生 CommonJS 对象。两个源文件映射到同一个产物路径时会报告冲突并保留既有声明与清单。生成文件使用原子替换，遇到同名手写文件会报错。

## 验证

在仓库根目录运行 `pnpm test`。也可先 `pnpm build`，再运行 `node --test packages/model/test/*.test.js`。测试覆盖真实 HTTP 和 SQLite 接入、依赖变化、在途调用排空、注册回滚、声明生成、构建清单和监听关闭。 [运行时测试](test/model.test.js) · [目录测试](test/loader.test.js) · [类型生成测试](test/typegen.test.js)
