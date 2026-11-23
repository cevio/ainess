import assert from 'node:assert/strict'
import test from 'node:test'
import { typeorm } from '@ainess/typeorm'
import { Context } from '@deepseek-ai/cordis'
import { EntitySchema } from 'typeorm'

test('database consumers start with a live DataSource and finish before it closes', async (t) => {
  const note = new EntitySchema({
    name: 'Note',
    columns: {
      id: { type: Number, primary: true, generated: true },
      text: { type: String },
    },
  })
  const app = new Context()
  t.after(() => app.fiber.dispose())

  let rowsAtStart = 0
  let rowsAtDispose = 0
  const consumer = app.plugin({
    inject: ['typeorm'],
    async apply(ctx) {
      const repository = ctx.typeorm.getRepository(note)
      await repository.save({ text: 'through Cordis' })
      rowsAtStart = await repository.count()
      ctx.effect(() => async () => {
        rowsAtDispose = await ctx.typeorm.getRepository(note).count()
      })
    },
  })
  await consumer.await()
  assert.equal(rowsAtStart, 0)

  const provider = await app.plugin(typeorm, {
    type: 'sqljs',
    entities: [note],
    synchronize: true,
  }).await()
  await consumer.await()

  const dataSource = app.get('typeorm')
  assert.ok(dataSource?.isInitialized)
  assert.equal(rowsAtStart, 1)

  await provider.dispose()
  assert.equal(rowsAtDispose, 1)
  assert.equal(dataSource.isInitialized, false)
  assert.equal(app.get('typeorm'), undefined)
})

test('an initialization error leaves the service available for a new provider', async (t) => {
  const app = new Context()
  t.after(() => app.fiber.dispose())

  const invalid = new EntitySchema({
    name: 'Invalid',
    columns: { text: { type: String } },
  })
  const failed = app.plugin(typeorm, { type: 'sqljs', entities: [invalid] })

  await assert.rejects(failed.await(), { name: 'MissingPrimaryColumnError' })
  assert.equal(app.get('typeorm', false), undefined)

  await app.plugin(typeorm, { type: 'sqljs' }).await()
  assert.ok(app.get('typeorm')?.isInitialized)
})
