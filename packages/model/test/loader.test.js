import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { models } from '@ainess/model'
import { loadModels } from '@ainess/model/loader'
import { Context } from '@deepseek-ai/cordis'
import { ordersModel } from './fixtures/orders.js'

const fixture = JSON.stringify(import.meta.resolve('./fixtures/orders.js'))

/** @param {import('node:test').TestContext} t */
async function createHarness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-model-loader-'))
  const app = new Context()
  t.after(async () => {
    await app.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const registry = await app.plugin(models).await()
  return { app, directory, registry }
}

test('loads Model definitions by their declared names and keeps each registration accessible', async (t) => {
  const { app, directory } = await createHarness(t)
  await mkdir(join(directory, 'nested'))
  await writeFile(join(directory, 'a.model.mjs'), `export { ordersModel as default } from ${fixture}`)
  await writeFile(join(directory, 'nested', 'another.model.mjs'), `export { resourceModel as default } from ${fixture}`)
  await writeFile(join(directory, 'ignored.model.js'), 'throw new Error("unexpected extension")')
  await writeFile(join(directory, 'ignored.mjs'), 'throw new Error("unexpected suffix")')

  const owner = await app.plugin({ inject: ['models'], apply() {} }).await()
  const registrations = await loadModels(owner.ctx, { directory: pathToFileURL(directory), extensions: ['.mjs'] })
  assert.deepEqual(registrations.map(registration => registration.name), ['orders', 'resource'])
  assert.deepEqual(await app.models.orders.cancellationPolicy({ status: 'paid' }, { caller: undefined }), {
    canCancel: false,
  })
  assert.equal(app.get('models.orders.cancelOrder'), undefined)

  await app.models.unregister(registrations[0])
  assert.equal(app.get('models.orders'), undefined)
  assert.ok(app.get('models.resource'))
  await owner.dispose()
  assert.equal(app.get('models.resource'), undefined)
  assert.ok(app.models)
})

test('validates all default exports before publishing any Model', async (t) => {
  const { app, directory } = await createHarness(t)
  await writeFile(join(directory, 'first.model.mjs'), `export { ordersModel as default } from ${fixture}`)
  await writeFile(join(directory, 'invalid.model.mjs'), 'export default { name: "invalid", methods: {} }')

  await assert.rejects(loadModels(app, { directory }), /invalid\.model\.mjs.*defineModel/)
  assert.equal(app.get('models.orders'), undefined)
})

test('rejects an invalid method definition before mounting any Model in the directory', async (t) => {
  const { app, directory } = await createHarness(t)
  const modelModule = JSON.stringify(import.meta.resolve('@ainess/model'))
  await writeFile(join(directory, 'first.model.mjs'), `export { ordersModel as default } from ${fixture}`)
  await writeFile(join(directory, 'invalid.model.mjs'), `
    import { defineModel } from ${modelModule}
    export default defineModel('resource', { read: { inject: [] } })
  `)

  await assert.rejects(loadModels(app, { directory }), /invalid\.model\.mjs.*defineModelOperation/)
  assert.equal(app.get('models.orders'), undefined)
  assert.equal(app.get('models.resource'), undefined)
})

test('reports both source files when a directory declares the same Model twice', async (t) => {
  const { app, directory } = await createHarness(t)
  for (const file of ['first.model.mjs', 'second.model.mjs']) {
    await writeFile(join(directory, file), `export { ordersModel as default } from ${fixture}`)
  }

  await assert.rejects(loadModels(app, { directory }), /orders.*first\.model\.mjs.*second\.model\.mjs/)
  assert.equal(app.get('models.orders'), undefined)
})

test('rolls back the Models from a directory when a later registration conflicts', async (t) => {
  const { app, directory } = await createHarness(t)
  const existing = app.models.register(ordersModel)
  await existing.fiber.await()
  const policy = app.models.orders.cancellationPolicy
  await writeFile(join(directory, 'a-resource.model.mjs'), `export { resourceModel as default } from ${fixture}`)
  await writeFile(join(directory, 'conflict.model.mjs'), `export { ordersModel as default } from ${fixture}`)

  await assert.rejects(loadModels(app, { directory }), /conflict\.model\.mjs.*models\.orders.*registered/)
  assert.equal(app.get('models.resource', false), undefined)
  assert.equal(app.models.orders.cancellationPolicy, policy)
})

for (const retired of ['owner', 'registry']) {
  test(`disposing the ${retired} during import skips later imports and Models`, { timeout: 5000 }, async (t) => {
    const { app, directory, registry } = await createHarness(t)
    const key = `ainess-model-loader:${directory}`
    const gate = new EventEmitter()
    const laterImport = t.mock.fn()
    gate.on('later-import', laterImport)
    Reflect.set(globalThis, key, gate)

    try {
      await writeFile(join(directory, 'delayed.model.mjs'), `
        const gate = Reflect.get(globalThis, ${JSON.stringify(key)})
        await new Promise(resolve => {
          gate.once('continue', resolve)
          gate.emit('importing')
        })
        export { ordersModel as default } from ${fixture}
      `)
      await writeFile(join(directory, 'later.model.mjs'), `
        Reflect.get(globalThis, ${JSON.stringify(key)}).emit('later-import')
        export { resourceModel as default } from ${fixture}
      `)

      const importing = once(gate, 'importing', { signal: AbortSignal.timeout(3000) })
      const owner = app.plugin({
        inject: ['models'],
        async apply(ctx) {
          await loadModels(ctx, { directory })
        },
      })
      await importing
      const stopping = (retired === 'owner' ? owner : registry).dispose()
      gate.emit('continue')
      await stopping
      await owner.await()
      assert.equal(laterImport.mock.callCount(), 0)
      assert.equal(app.get('models.orders', false), undefined)
      assert.equal(app.get('models.resource', false), undefined)
    } finally {
      gate.emit('continue')
      Reflect.deleteProperty(globalThis, key)
    }
  })
}
