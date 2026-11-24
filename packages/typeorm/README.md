# @ainess/typeorm

把原生 TypeORM `DataSource` 注册为 Cordis 的 `typeorm` 服务。宿主依赖 `@ainess/typeorm`、工作区所用的 `@deepseek-ai/cordis`、`typeorm` `^1.1.3` 及数据库驱动。应用提供连接选项、实体和数据库结构策略。 [TypeORM 数据源选项](https://typeorm.io/docs/data-source/data-source-options/)

## 快速开始

使用 `sql.js` 驱动创建内存数据库。保存为 `notes.mjs`，运行 `node notes.mjs`。示例在一个事务中写入并读取数据。

```js
import { typeorm } from '@ainess/typeorm'
import { Context } from '@deepseek-ai/cordis'
import { EntitySchema } from 'typeorm'

const note = new EntitySchema({
  name: 'Note',
  columns: {
    id: { type: Number, primary: true, generated: true },
    text: { type: String },
  },
})

const app = new Context()
try {
  await app.plugin(typeorm, {
    type: 'sqljs',
    entities: [note],
    synchronize: true,
  }).await()

  await app.plugin({
    inject: ['typeorm'],
    async apply(ctx) {
      const text = await ctx.typeorm.transaction(async (manager) => {
        const repository = manager.getRepository(note)
        const saved = await repository.save({ text: 'through Cordis' })
        const found = await repository.findOneByOrFail({ id: saved.id })
        return found.text
      })
      console.log(text)
    },
  }).await()
} finally {
  await app.fiber.dispose()
}
```

## 公开接口与归属

- 从 `@ainess/typeorm` 导入 `typeorm`，用 `ctx.plugin(typeorm, options)` 安装。`options` 就是 `DataSourceOptions`，包含由所选驱动要求的字段。框架应用可以在 `plugins` 组使用 `use(typeorm, options)`。 [应用装配](../framework/README.md)
- 消费插件声明 `inject: ['typeorm']`。`ctx.typeorm` 是原生 `DataSource`，可用 `getRepository()`、`transaction()` 等方法。事务内统一使用回调的 `manager` 或由它取得的 repository，确保操作落在同一事务中。 [TypeORM DataSource](https://typeorm.io/docs/data-source/data-source/) · [TypeORM 事务](https://typeorm.io/docs/advanced-topics/transactions/)
- 同一个 Cordis 隔离作用域挂载一个 `typeorm` 提供者。消费者共享已初始化的数据源或连接池。连接的初始化和 `destroy()` 由提供者管理，普通查询和事务直接用 `ctx.typeorm`。
- 消费者在数据库就绪后激活。初始化失败由提供者的 `Fiber.await()` 传播，修正配置后可重新挂载。卸载时先完成依赖方的清理，再释放数据源。消费者离开作用域时停止自己的后台工作，使其清理在连接仍可用时结束。

## 验证

在仓库根目录运行 `pnpm test`，或运行 `pnpm build` 后执行 `node --test packages/typeorm/test/typeorm.test.js`。测试使用 `sql.js`，验证实际读写、失败后重新加载和依赖方先于数据源关闭。 [数据库测试](test/typeorm.test.js)
