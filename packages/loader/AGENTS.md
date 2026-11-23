# @ainess/loader 开发指引

- `scanModules(options)` 只扫描文件，按相对路径排序返回匹配字面后缀的普通文件。扩展名默认 `.js` 和 `.mjs`，可通过 `extensions` 替换。扫描包含隐藏目录，跳过目录内的符号链接。目录读取失败时拒绝本次扫描。
- 文件记录包含绝对路径、以 `/` 分段的相对路径和移除扫描后缀及扩展名的 `stem`。`importModules(files, decode)` 按传入顺序用原生 ESM 导入所选文件。`decode` 接收默认导出和文件来源，可返回同步或异步结果。缺少默认导出、导入失败或解码失败时，错误包含文件路径和原因。`loadModules(options, decode)` 组合扫描与导入。
- `parseFileRoute(stem, { prefix?, source? })` 解析静态段、`[name]` 和末尾 `[...name]`。文件目录中的 `(group)` 段从路由中省略，文件名 `index` 表示所在目录。参数重名和其他路径语法错误可以在导入前发现。消费包使用这些路径段组装自己的注册键，并管理注册和卸载。
- 包依赖 `glob` 扫描目录，使用 Node.js 原生文件和 URL API 打开目标目录并导入模块。构建产物 `dist/` 提供运行时和类型入口。运行根目录的 `pnpm test` 验证实际目录扫描、不同后缀复用、导入错误和文件路由语法。
