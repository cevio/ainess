# @ainess/loader

需要新模块类型或文件路由时，用 `scanModules({ directory, suffix, extensions })` 取有序文件清单，用 `parseFileRoute(stem, { prefix, source })` 解析路径，再用 `importModules(files, decode, signal?)` 导入和校验选中的默认导出。只需要全部扫描和导入时使用 `loadModules()`。先校验可从文件路径判断的错误，再执行模块。消费方负责业务注册、取消及资源清理。 [loader 手册](https://github.com/cevio/ainess/blob/main/packages/loader/README.md)

## 复用 Loader

开发其他目录插件时，复用扫描和导入。应用需要 `@ainess/loader`。先在 `views/(public)/index.view.mjs` 保存以下定义。

```js
export default 'home'
```

在项目根目录保存 `load-views.mjs`。运行 `node load-views.mjs`，解析结果包含静态段 `preview`，消费包可用它注册 `/preview`。`(public)` 分组段在解析时省略，模块的默认导出为 `home`。

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

`scanModules()` 默认匹配 `.js` 和 `.mjs`，可按需传入 `extensions`。它先给出按相对路径排序的记录，便于导入前统一发现路径错误。`importModules()` 依次执行模块并把默认导出交给解码器。信号中止后等当前步骤结束，跳过后续导入。消费插件管理业务注册、冲突回滚和卸载。无需预处理时可直接用 `loadModules(options, decode)`。 [HTTP Controller](http.md) · [Model 目录](model.md#按目录装配并调用) · [Micro Controller](micro.md#通过-micro-调用已登记服务)
