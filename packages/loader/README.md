# @ainess/loader

为按目录装配的功能提供模块扫描、默认导出解码和文件路由解析。它使用 Node.js 文件及 ESM API，包内依赖 `glob`。需要装配 HTTP Controller 或 Model 时，优先使用对应包的目录入口，由该包管理业务定义、注册和清理。 [HTTP Controller](../http/README.md#按目录装配-controller) · [Model 目录](../model/README.md#按目录装配)

## 快速开始

宿主使用 `@ainess/loader`。创建 `tasks/health.task.mjs`，以默认导出提供一个任务定义。

```js
export default 'health'
```

把下面的内容保存为同级的 `scan.mjs`，运行 `node scan.mjs`。指定目录相对于此模块，从其他工作目录执行也能找到它。

```js
import { loadModules } from '@ainess/loader'

const tasks = await loadModules({
  directory: new URL('./tasks/', import.meta.url),
  suffix: 'task',
}, (value) => {
  if (typeof value !== 'string') throw new TypeError('Expected a task name')
  return value
})

for (const { file, value } of tasks) {
  console.log(file.relativePath, file.stem, value)
}
```

输出为 `health.task.mjs health health`。业务包在解码函数中验证自己的定义，然后使用已验证的 `value`。

## 扫描与导入

| 从 `@ainess/loader` 导入 | 用法 |
| --- | --- |
| `scanModules(options)` | 扫描并返回 `Promise<readonly ModuleFile[]>`。可先检查路径、排序后的清单或筛选需要导入的文件。 |
| `importModules(files, decode, signal?)` | 按输入顺序导入并解码。`decode(value: unknown, file: ModuleFile)` 可同步或异步返回 `T`。返回 `Promise<readonly { file: ModuleFile; value: T }[]>`。 |
| `loadModules(options, decode)` | 组合全量扫描与导入。全部候选都需要加载时直接调用。 |

`LoadModulesOptions` 的 `directory` 是工作目录相对路径、绝对路径或 `file:` URL。`suffix` 是非空字面文件名后缀，如 `task`，匹配 `.<suffix><extension>`。`extensions` 接受字符串数组，默认 `['.js', '.mjs']`。传入自定义数组会替换默认值，格式错误时抛出 `TypeError`。扫描只收集普通文件，大小写敏感，包含隐藏目录并跳过目录内的符号链接。目录不存在、根路径是文件或目录读取失败时会拒绝。

`ModuleFile` 提供 `absolutePath`、用 `/` 分段的 `relativePath`，以及去掉后缀和扩展名的 `stem`。例如 `tasks/health.task.mjs` 在上例中的 `relativePath` 是 `health.task.mjs`，`stem` 是 `health`。扫描按相对路径排序。

`scanModules()` 只读目录。需要在执行模块前校验整批路径时，先扫描，校验后再用 `importModules()` 处理选定的文件。导入会执行模块顶层代码，并遵循 Node 的 ESM 缓存语义。把注册、连接和其他可清理的资源交给消费方，便于在导入或解码失败后回收。缺少默认导出、导入失败或解码失败时，错误带文件相对路径和 `cause`。

可选的 `AbortSignal` 由调用方控制。中止时 `importModules()` 会等正在执行的原生导入或解码结束，跳过后续步骤，并用信号的原因拒绝整个任务。

## 文件路由

`parseFileRoute(stem, options?: FileRouteOptions): readonly FileRouteSegment[]` 从文件 `stem` 解析路径段。`prefix` 默认为空，可用 `/api` 或 `/api/` 前置路径，`source` 可填相对文件路径供报错定位。

| 写法 | 结果 |
| --- | --- |
| `users/index` | `users` 静态段。文件名 `index` 表示所在目录。 |
| `users/(staff)/[id]` | `users` 静态段及 `id` 参数。`(staff)` 组织源码目录。 |
| `files/[...parts]` | `files` 静态段及末尾 `parts` 通配段。 |

`FileRouteSegment` 按 `kind` 区分 `{ kind: 'static', value }`、`{ kind: 'parameter', name }` 和 `{ kind: 'catch-all', name }`。消费方将段转换成目标路由器支持的语法。空段、非法静态段、无效或重复的参数名、出现在中间的通配段会抛出 `TypeError`。单独的 `index` 对应零段，消费方可将它映射成根路径。

## 验证

在仓库根目录先运行 `pnpm build`，再运行 `node --test packages/loader/test/loader.test.js`。根 `pnpm test` 也包含此用例。测试用临时目录验证真实扫描、选择性导入、路径语法和失败原因。 [扫描与路由测试](test/loader.test.js)
