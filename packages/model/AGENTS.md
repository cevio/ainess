# @ainess/model 开发指引

方法定义、目录装配和类型生成见[使用手册](README.md)。

- `models` 提供顶层 Cordis 注册器 `ctx.models`。`defineModel()` 声明领域及其方法。手动和目录注册均接收该工厂返回的定义。应用在同根 Context 中注册领域，注册句柄归调用方 Fiber 管理，`unregister()` 卸载对应领域 Fiber。
- `defineModelOperation({ schema, inject?, execute })` 让每个方法声明必需的 Cordis 服务。创建定义时检查 Schema 接口、执行函数和 `inject` 数组。方法在自己的子 Fiber 中等待依赖，通过点号服务暴露为 `ctx.models.<领域>.<方法>`。消费插件在 `inject` 中声明领域及所需方法的服务键。方法定义使用自有字符串键。
- 入口映射并使用 `inputSchema` 校验业务输入，Model 方法接收解析后的输入和 `ModelCall`。`execute(input, call, dependencies)` 的第三个参数由本方法的 `inject` 推导，条件列表中可能缺席的服务为可选属性。`ModelTypes` 通过 `InferModel` 从 Model 定义获得方法签名。
- 方法离开就绪状态时停止接收新调用，清理时等待已接收的执行结束。重新就绪会产生新的方法引用。领域卸载回收它的所有方法 Fiber，注册器与其他领域按各自 Fiber 管理生命周期。
- `@ainess/model/loader` 的 `loadModels(ctx, { directory, extensions? })` 复用 `@ainess/loader` 扫描 `*.model.js` 和 `*.model.mjs`。文件默认导出 `defineModel()` 的结果，领域名由定义提供。加载在全部定义检查通过后开始注册，失败或调用方卸载时撤销本批注册。加载期间卸载或失去必需服务时跳过后续模块导入。返回的句柄可以单独卸载领域。
- 同一入口导出 Cordis 插件 `modelDirectory`，注入 `models`，并在启动时调用 `loadModels()`。插件配置复用 `ModelLoaderOptions`，支持直接指定目录或传入共享配置文件。
- 类型生成默认从 `.ts`、`.mts`、`.js`、`.mjs` 源文件写入静态类型引用，用定义中的领域名扩展 `ModelTypes`。应用将输出纳入 `tsconfig`。
- `@ainess/model/typegen` 提供 `prepareModelBuild(config)` 和 `watchModelTypes(config, onError?)`。前者写入声明并返回构建成功后调用的发布函数。发布时核对运行时产物及当前声明，校验失败时保留现有清单。后者同步首份声明和开发清单并开始监听，返回开发结束时调用的异步清理函数。
- 钩子和 `loadModels(ctx, { config })` 共用 JSON 配置。`sourceRoot` 和 `runtimeRoot` 默认是相对配置文件的 `src` 和 `dist`，`directory` 默认是共用的 `models` 子目录。`declaration` 相对于源码根，默认 `models.generated.d.ts`。配置指向的 Model 目录尚未创建时按空目录处理。
- 共享配置下，声明与 `.ainess-models.json` 由同一次源码扫描产生。多个源码映射到同一运行时产物时，报告冲突并保留既有声明和清单。配置 `.cts` 和 `.cjs` 时支持用 `export =` 绑定 CommonJS Model。运行清单随编译目录发布，loader 据此选择本次构建的 Model，清单中的编译文件缺失时报告具体路径。生成文件使用原子替换，只覆盖本工具生成的文件。监听期间的后续生成串行执行。
- Cordis 由宿主提供，Standard Schema 定义方法的输入契约。测试使用 HTTP 和 TypeORM 验证真实入口和依赖切换。运行根目录 `pnpm test` 验证类型生成、注册卸载、目录加载、方法隔离和 HTTP 接入。
