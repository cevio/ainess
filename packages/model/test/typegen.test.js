import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as typegen from '@ainess/model/typegen'

const exec = promisify(execFile)
const tsc = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')))
const { prepareModelBuild, watchModelTypes } = typegen

test('typegen exposes the two framework hooks without a package command', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(Object.hasOwn(manifest, 'bin'), false)
  assert.deepEqual(Object.keys(typegen), ['prepareModelBuild', 'watchModelTypes'])
})

test('the build hook generates inferred types from the same Model directory config used by the loader', async (t) => {
  const project = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(project, { recursive: true, force: true }))
  const config = join(project, 'ainess.models.json')
  const directory = join(project, 'src', 'features', 'models')
  const output = join(project, 'src', 'types', 'models.generated.d.ts')
  await mkdir(join(directory, '.domain'), { recursive: true })
  await writeFile(config, JSON.stringify({
    sourceRoot: 'src',
    runtimeRoot: 'dist',
    directory: 'features/models',
    declaration: 'types/models.generated.d.ts',
    sourceExtensions: ['.ts', '.mts', '.cts'],
    runtimeExtensions: ['.js', '.mjs', '.cjs'],
  }))
  await writeFile(join(directory, '.domain', 'order-actions.model.ts'), `
    import { defineModel, defineModelOperation, type ModelCall } from '@ainess/model'
    import type { StandardSchemaV1 } from '@standard-schema/spec'

    const schema: StandardSchemaV1<string, { orderId: number }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: { orderId: 42 } }),
      },
    }
    export default defineModel('orders', {
      cancelOrder: defineModelOperation({
        schema,
        execute({ orderId }, call: ModelCall<{ userId: string }>) {
          return { orderId, operator: call.caller.userId, status: 'cancelled' as const }
        },
      }),
    })
  `)
  await writeFile(join(directory, 'billing.model.mts'), `
    import { defineModel } from '@ainess/model'
    export default defineModel('billing', {})
  `)
  await writeFile(join(directory, 'inventory.model.cts'), `
    import model = require('@ainess/model')
    export = model.defineModel('inventory', {})
  `)
  await writeFile(join(directory, 'ignored.mts'), 'export default false')

  const appFile = join(project, 'src', 'app.ts')
  const application = `
    import assert from 'node:assert/strict'
    import { models } from '@ainess/model'
    import { loadModels } from '@ainess/model/loader'
    import { Context } from '@deepseek-ai/cordis'

    const app = new Context()
    const call = { caller: { userId: 'staff' } }
    try {
      await app.plugin(models).await()
      await app.plugin({
        inject: ['models'],
        async apply(ctx) {
          await loadModels(ctx, { config: new URL('../ainess.models.json', import.meta.url) })
        },
      }).await()
      const result = await app.models.orders.cancelOrder({ orderId: 42 }, call)
      const status: 'cancelled' = result.status
      assert.deepEqual(result, { orderId: 42, operator: 'staff', status })
      assert.ok(app.models.billing)
      assert.ok(app.models.inventory)
    } finally {
      await app.fiber.dispose()
    }

    async function testTypes(ctx: Context) {
      const result = await ctx.models.orders.cancelOrder({ orderId: 42 }, call)
      // @ts-expect-error The return value retains the method's literal status type.
      const status: 'pending' = result.status
      // @ts-expect-error The schema provides the parsed input type.
      ctx.models.orders.cancelOrder({ orderId: '42' }, call)
      // @ts-expect-error The caller type comes from the method definition.
      ctx.models.orders.cancelOrder({ orderId: 42 }, { caller: {} })
      // @ts-expect-error Only discovered Models are exposed.
      return ctx.models.orderActions
    }
  `
  await writeFile(appFile, application)
  await writeFile(join(project, 'tsconfig.json'), JSON.stringify({
    extends: fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url)),
    compilerOptions: { rootDir: 'src', outDir: 'dist' },
    include: ['src'],
  }))

  const build = async () => {
    const publish = await prepareModelBuild(config)
    await exec(process.execPath, [tsc, '-p', project])
    await publish()
  }
  const start = () => exec(process.execPath, [join(project, 'dist', 'app.js')])
  await build()
  const declaration = await readFile(output, 'utf8')
  assert.match(declaration, /\.\.\/features\/models\/\.domain\/order-actions\.model\.js/)
  assert.match(declaration, /\.\.\/features\/models\/billing\.model\.mjs/)
  assert.match(declaration, /\.\.\/features\/models\/inventory\.model\.cjs/)
  assert.doesNotMatch(declaration, /ignored/)
  await start()

  const manifest = join(project, 'dist', 'features', 'models', '.ainess-models.json')
  const published = await readFile(manifest, 'utf8')
  await rename(join(directory, '.domain'), join(directory, '.moved'))
  await rm(join(directory, 'billing.model.mts'))
  await assert.rejects(build(), { stdout: /Property 'billing' does not exist/ })
  assert.equal(await readFile(manifest, 'utf8'), published)

  await writeFile(appFile, application.replace('assert.ok(app.models.billing)', `
    assert.equal(app.get('models.billing', false), undefined)
    // @ts-expect-error Removing a Model removes its type on the next build.
    void (false && app.models.billing)
  `))
  await build()
  const rebuilt = await readFile(output, 'utf8')
  assert.match(rebuilt, /\/\.moved\/order-actions\.model\.js/)
  assert.doesNotMatch(rebuilt, /\.domain|billing/)
  await readFile(join(project, 'dist', 'features', 'models', 'billing.model.mjs'))
  await rename(join(project, 'src'), join(project, 'not-deployed'))
  await start()

  await rm(join(project, 'dist', 'features', 'models', '.moved', 'order-actions.model.js'))
  await assert.rejects(start(), /Model artifact \.moved\/order-actions\.model\.js is missing/)
})

test('regeneration removes deleted Models without executing source modules', async (t) => {
  const directory = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const config = join(directory, 'ainess.models.json')
  const source = join(directory, 'removed.model.mjs')
  const output = join(directory, 'models.generated.d.ts')
  await writeFile(config, JSON.stringify({ sourceRoot: '.', directory: '.' }))
  await writeFile(source, 'throw new Error("Model executed during type generation")')

  await prepareModelBuild(config)
  assert.match(await readFile(output, 'utf8'), /\.\/removed\.model\.mjs/)
  await rm(source)
  await prepareModelBuild(config)
  assert.doesNotMatch(await readFile(output, 'utf8'), /removed/)
})

test('one untyped default export cannot widen the generated Model namespace under skipLibCheck', async (t) => {
  const project = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(project, { recursive: true, force: true }))
  await writeFile(join(project, 'known.model.ts'), `
    import { defineModel } from '@ainess/model'
    export default defineModel('known', {})
  `)
  await writeFile(join(project, 'missing-default.model.ts'), 'export const accidental = true')
  await writeFile(join(project, 'wrong-default.model.ts'), 'export default 42')
  const config = join(project, 'ainess.models.json')
  await writeFile(config, JSON.stringify({ sourceRoot: '.', directory: '.' }))
  await prepareModelBuild(config)
  await writeFile(join(project, 'caller.ts'), `
    import type { Context } from '@deepseek-ai/cordis'
    declare const ctx: Context
    void ctx.models.known
    // @ts-expect-error A module without a typed Model default cannot add arbitrary Model names.
    void ctx.models.unknownDomain
  `)
  await writeFile(join(project, 'tsconfig.json'), JSON.stringify({
    extends: fileURLToPath(new URL('../../../tsconfig.base.json', import.meta.url)),
    compilerOptions: { noEmit: true, skipLibCheck: true },
    include: ['*.ts'],
  }))
  await exec(process.execPath, [tsc, '-p', project])
})

test('build preserves an existing source file when it is selected as the declaration output', async (t) => {
  const project = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(project, { recursive: true, force: true }))
  const config = join(project, 'ainess.models.json')
  const source = join(project, 'src', 'app.ts')
  await mkdir(join(project, 'src'))
  await writeFile(source, 'export const app = true\n')
  await writeFile(config, JSON.stringify({ declaration: 'app.ts' }))

  await assert.rejects(prepareModelBuild(config), /refusing to overwrite.*app\.ts/i)
  assert.equal(await readFile(source, 'utf8'), 'export const app = true\n')
})

test('conflicting Model source paths leave the last declaration and manifest intact', async (t) => {
  const project = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(project, { recursive: true, force: true }))
  const config = join(project, 'ainess.models.json')
  const directory = join(project, 'src/models')
  const runtime = join(project, 'dist/models')
  const declaration = join(project, 'src/models.generated.d.ts')
  const manifest = join(runtime, '.ainess-models.json')
  await mkdir(directory, { recursive: true })
  await mkdir(runtime, { recursive: true })
  await writeFile(config, '{}')
  const inventory = `
    import { defineModel } from '@ainess/model'
    export default defineModel('inventory', {})
  `
  await writeFile(join(directory, 'inventory.model.ts'), inventory)
  await writeFile(join(runtime, 'inventory.model.js'), inventory)

  const publish = await prepareModelBuild(config)
  await publish()
  const existing = await Promise.all([readFile(declaration, 'utf8'), readFile(manifest, 'utf8')])
  await writeFile(join(directory, 'inventory.model.js'), `
    import { defineModel } from '@ainess/model'
    export default defineModel('oldInventory', {})
  `)

  await assert.rejects(prepareModelBuild(config), /inventory\.model\.js.*inventory\.model\.ts.*inventory\.model\.js/)
  assert.deepEqual(await Promise.all([readFile(declaration, 'utf8'), readFile(manifest, 'utf8')]), existing)
})

test('publishing missing Model artifacts preserves the last manifest and can be retried', async (t) => {
  const project = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(project, { recursive: true, force: true }))
  const config = join(project, 'ainess.models.json')
  const directory = join(project, 'src/models')
  const runtime = join(project, 'dist/models')
  const manifest = join(runtime, '.ainess-models.json')
  await mkdir(directory, { recursive: true })
  await mkdir(runtime, { recursive: true })
  await writeFile(config, '{}')
  const orders = "import { defineModel } from '@ainess/model'\nexport default defineModel('orders', {})\n"
  const inventory = "import { defineModel } from '@ainess/model'\nexport default defineModel('inventory', {})\n"
  await writeFile(join(directory, 'orders.model.ts'), orders)
  await writeFile(join(runtime, 'orders.model.js'), orders)
  const publishOrders = await prepareModelBuild(config)
  await publishOrders()
  const existing = await readFile(manifest, 'utf8')

  await writeFile(join(directory, 'inventory.model.ts'), inventory)
  const publish = await prepareModelBuild(config)
  await assert.rejects(publish, /Model artifact inventory\.model\.js is missing/)
  assert.equal(await readFile(manifest, 'utf8'), existing)

  await writeFile(join(runtime, 'inventory.model.js'), inventory)
  await publish()
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).files, ['inventory.model.js', 'orders.model.js'])
})

test('a superseded build cannot replace the manifest for the current declaration', async (t) => {
  const project = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(project, { recursive: true, force: true }))
  const config = join(project, 'ainess.models.json')
  const directory = join(project, 'src/models')
  const runtime = join(project, 'dist/models')
  const manifest = join(runtime, '.ainess-models.json')
  await mkdir(directory, { recursive: true })
  await mkdir(runtime, { recursive: true })
  await writeFile(config, '{}')
  const inventory = "import { defineModel } from '@ainess/model'\nexport default defineModel('inventory', {})\n"
  await writeFile(join(directory, 'first.model.ts'), inventory)
  await writeFile(join(runtime, 'first.model.js'), inventory)
  const publishOlder = await prepareModelBuild(config)
  await rename(join(directory, 'first.model.ts'), join(directory, 'second.model.ts'))
  await writeFile(join(runtime, 'second.model.js'), inventory)
  const publishNewer = await prepareModelBuild(config)
  await publishNewer()

  await assert.rejects(publishOlder, /Model declaration .*changed after preparing/)
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).files, ['second.model.js'])
})

test('the dev hook tracks Model changes until its cleanup function runs', { timeout: 12000 }, async (t) => {
  const project = await mkdtemp(fileURLToPath(new URL('.typegen-', import.meta.url)))
  t.after(() => rm(project, { recursive: true, force: true }))
  const config = join(project, 'ainess.models.json')
  const root = join(project, 'src')
  const directory = join(root, 'models')
  const output = join(root, 'models.generated.d.ts')
  await mkdir(root)
  await writeFile(config, JSON.stringify({ directory: 'models' }))

  /** @param {RegExp} expected @param {RegExp} [excluded] */
  async function waitForDeclaration(expected, excluded) {
    const signal = AbortSignal.timeout(3000)
    for (;;) {
      const text = await readFile(output, 'utf8')
      if (expected.test(text) && !excluded?.test(text)) return
      await delay(25, undefined, { signal })
    }
  }

  /** @type {unknown[]} */
  const errors = []
  const stop = await watchModelTypes(config, error => errors.push(error))
  try {
    assert.match(await readFile(output, 'utf8'), /ModelDefinitions = never/)
    await mkdir(directory)
    await writeFile(join(directory, 'orders.model.ts'), 'export default {}')
    await waitForDeclaration(/\.\/models\/orders\.model\.js/)

    await mkdir(join(directory, 'nested'))
    await rename(join(directory, 'orders.model.ts'), join(directory, 'nested', 'orders.model.ts'))
    await waitForDeclaration(/models\/nested\/orders\.model\.js/, /models\/orders\.model\.js/)

    await rm(join(directory, 'nested', 'orders.model.ts'))
    await waitForDeclaration(/ModelDefinitions = never/, /orders/)

    await writeFile(join(directory, 'products.model.mts'), 'export default {}')
    await waitForDeclaration(/models\/products\.model\.mjs/)
    await rename(directory, join(root, 'outside-models'))
    await waitForDeclaration(/ModelDefinitions = never/, /products/)
    await rename(join(root, 'outside-models'), directory)
    await waitForDeclaration(/models\/products\.model\.mjs/)
  } finally {
    await stop()
  }
  assert.deepEqual(errors, [])
  const declaration = await readFile(output, 'utf8')
  const manifest = await readFile(join(project, 'dist', 'models', '.ainess-models.json'), 'utf8')
  assert.deepEqual(JSON.parse(manifest).files, ['products.model.mjs'])
  await rm(join(directory, 'products.model.mts'))
  await delay(150)
  assert.equal(await readFile(output, 'utf8'), declaration)
})
