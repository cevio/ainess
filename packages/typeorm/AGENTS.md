# @ainess/typeorm 开发指引

数据源配置、事务和清理示例见[使用手册](README.md)。

- `src/index.ts` 导出 Cordis 运行时插件 `typeorm`，接收 TypeORM 的 `DataSourceOptions`。应用负责提供数据库配置、驱动和实体。消费插件声明 `inject: ['typeorm']`，通过 `ctx.typeorm` 使用原生 `DataSource`。
- 同一个 Cordis 隔离作用域由一个 Fiber 提供 `typeorm` 服务。插件在 `ctx.effect()` 中等待连接初始化，Cordis 激活 Fiber 后才向消费者提供服务。启动错误通过 `Fiber.await()` 传播。
- 连接由提供者生命周期管理。Cordis 等依赖该服务的插件完成清理后，再释放连接或连接池。数据库结构行为由应用传入的 TypeORM 选项决定。
- Cordis 和 TypeORM 由应用提供为 peer dependencies。`sql.js` 用于测试中的内存 SQLite。运行根目录的 `pnpm test` 验证注入、真实读写、关闭顺序和初始化失败后的重新加载。
- 包的运行时与类型入口从 `dist/` 提供。打包验证应检查 tarball 中的 `dist/index.js`、`dist/index.d.ts` 和使用手册。
