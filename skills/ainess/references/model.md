# @ainess/model

从 `@ainess/model` 导入 `models`、`defineModel()` 和 `defineModelOperation()`。安装 `models` 后，用 `ctx.models.register(definition)` 显式注册，或通过 `@ainess/model/loader` 的 `modelDirectory` 扫描默认导出的 `*.model.js`、`*.model.mjs`。已有装配插件可以声明 `models` 注入并等待 `loadModels(ctx, options)`。 [Model 手册](https://github.com/cevio/ainess/blob/main/packages/model/README.md)

消费插件声明 `models`、领域和实际调用的方法三个服务键。在入口用方法的 `inputSchema` 校验，再将解析结果和 `{ caller, signal }` 传给方法。每个方法独立等待自己的 `inject`，由 `execute(input, call, dependencies)` 的第三个参数获取服务。卸载时停止接收新调用并等待已接收工作结束，依赖重新就绪后使用当前注入的方法引用。 [HTTP 入口与数据库依赖](http.md#运行-httpmodel-和-typeorm)

## 按目录装配并调用

宿主提供 `@ainess/model` 和 `@deepseek-ai/cordis`。将定义保存为 `models/greetings.model.mjs`。

```js
import { defineModel, defineModelOperation } from '@ainess/model'

export default defineModel('greetings', {
  hello: defineModelOperation({
    schema: {
      '~standard': {
        version: 1,
        vendor: 'greetings-example',
        validate(value) {
          if (typeof value === 'string' && value.trim()) return { value: value.trim() }
          return { issues: [{ message: 'Expected a non-empty name' }] }
        },
      },
    },
    execute(name) {
      return `Hello, ${name}!`
    },
  }),
})
```

在同一个应用中保存 `greeting.mjs`，运行 `node greeting.mjs` 应输出 `Hello, Ada!`。

```js
import { models } from '@ainess/model'
import { modelDirectory } from '@ainess/model/loader'
import { Context } from '@deepseek-ai/cordis'

const ctx = new Context()
try {
  await ctx.plugin(models).await()
  await ctx.plugin(modelDirectory, { directory: new URL('./models/', import.meta.url) }).await()
  await ctx.plugin({
    inject: ['models', 'models.greetings', 'models.greetings.hello'],
    async apply(ctx) {
      const hello = ctx.models.greetings.hello
      const parsed = await hello.inputSchema['~standard'].validate(' Ada ')
      if (parsed.issues) throw new TypeError('Invalid greeting input')
      console.log(await hello(parsed.value, { caller: null }))
    },
  }).await()
} finally {
  await ctx.fiber.dispose()
}
```

## 为 Model 生成类型

TypeScript 应用可手动用 `InferModel<typeof definition>` 扩展 `ModelTypes`，也可通过 `@ainess/model/typegen` 集中生成声明。使用集中生成时，在 ESM 应用根目录保存 `ainess.models.json`。

```json
{
  "sourceRoot": "src",
  "runtimeRoot": "dist",
  "directory": "models"
}
```

将 `*.model.ts` 或 `*.model.mts` 定义放到 `src/models/` 并保留默认导出。将 `src/models.generated.d.ts` 纳入应用的 `tsconfig.json`。在使用 NodeNext 编译到 `dist/` 的应用中，可将以下内容存为 `build.mjs`。

```js
import { execFileSync } from 'node:child_process'
import { prepareModelBuild } from '@ainess/model/typegen'

const root = new URL('./', import.meta.url)
const publish = await prepareModelBuild(new URL('./ainess.models.json', root))
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' })
await publish()
```

运行 `node build.mjs`。编译成功后，发布函数核对 Model 产物和当前声明再写入清单。给 `modelDirectory` 传入指向同一配置的 `{ config }`。例如入口位于 `dist/greeting.js` 时，用 `new URL('../ainess.models.json', import.meta.url)`。部署时带上配置、编译产物及 `dist/models/.ainess-models.json`。

开发流程可用 `watchModelTypes(config, reportError)` 更新声明和清单，退出时等待返回的关闭函数。应用的编译工具和进程管理器负责更新运行产物和重启。 [完整 TypeScript 示例](https://github.com/cevio/ainess/blob/main/packages/model/README.md#快速开始)

确保每个 Model 源文件对应唯一的运行时产物路径。比如默认配置下，同目录的 `notes.model.ts` 和 `notes.model.js` 都会映射到 `notes.model.js`，准备构建时会报冲突。
