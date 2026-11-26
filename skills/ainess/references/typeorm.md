# @ainess/typeorm

宿主提供 TypeORM、所用驱动、实体和 `DataSourceOptions`。在 `plugins` 用 `use(typeorm, options)` 安装，消费者声明 `inject: ['typeorm']`，通过原生 `ctx.typeorm` 取 repository。Model 方法把 `typeorm` 写在自己的 `inject` 中，通过 `execute()` 的第三个参数使用。事务内使用回调的 manager。每个隔离作用域复用其活动数据源，由提供者初始化和关闭。 [TypeORM 手册](https://github.com/cevio/ainess/blob/main/packages/typeorm/README.md)

## 在事务中读写

示例依赖 `@ainess/typeorm`、`@deepseek-ai/cordis`、`typeorm` 和 `sql.js`。将其保存为 `transaction.mjs`，运行 `node transaction.mjs` 应输出 `Ainess`。示例在内存数据库中通过 `synchronize` 创建表。

```js
import { typeorm } from '@ainess/typeorm'
import { Context } from '@deepseek-ai/cordis'
import { EntitySchema } from 'typeorm'

const note = new EntitySchema({
  name: 'Note',
  columns: {
    id: { type: Number, primary: true },
    text: { type: String },
  },
})

const ctx = new Context()
try {
  await ctx.plugin(typeorm, { type: 'sqljs', entities: [note], synchronize: true }).await()
  await ctx.plugin({
    inject: ['typeorm'],
    async apply(ctx) {
      const saved = await ctx.typeorm.transaction(async (manager) => {
        const repository = manager.getRepository(note)
        await repository.insert({ id: 1, text: 'Ainess' })
        return repository.findOneByOrFail({ id: 1 })
      })
      console.log(saved.text)
    },
  }).await()
} finally {
  await ctx.fiber.dispose()
}
```

数据源初始化失败时，提供者的 `Fiber.await()` 报告启动错误。修正配置后可重新挂载。卸载先等待消费方完成清理，再关闭连接或连接池。框架应用可把数据源与 Model 装配在同一个 `plugins` 组。 [HTTP、Model 和 TypeORM 装配](http.md#运行-httpmodel-和-typeorm)
