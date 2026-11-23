import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { importModules, loadModules, parseFileRoute, scanModules } from '@ainess/loader'

/** @param {import('node:test').TestContext} t */
async function tempDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ainess-loader-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('scans without executing modules and imports only the selected files', async (t) => {
  const directory = await tempDirectory(t)
  await Promise.all([
    writeFile(join(directory, 'echo.handler.mjs'), 'export default "echo"'),
    writeFile(join(directory, 'z.handler.mjs'), 'throw new Error("module executed")'),
  ])

  const files = await scanModules({ directory, suffix: 'handler' })
  assert.deepEqual(files.map(({ relativePath, stem }) => [relativePath, stem]), [
    ['echo.handler.mjs', 'echo'],
    ['z.handler.mjs', 'z'],
  ])
  const [selected] = await importModules(files.slice(0, 1), value => value)
  assert.equal(selected.file, files[0])
  assert.equal(selected.value, 'echo')
  await assert.rejects(importModules(files.slice(1), value => value), /z\.handler\.mjs.*module executed/)
})

test('imports matching modules in relative path order and reuses the same API for handlers', async (t) => {
  const directory = await tempDirectory(t)
  const nested = join(directory, 'nested')
  const alias = join(directory, 'alias')
  await mkdir(nested)
  await Promise.all([
    writeFile(join(directory, 'package.json'), '{"type":"module"}'),
    writeFile(join(directory, 'z %.controller.js'), 'export default "last"'),
    writeFile(join(nested, 'index.controller.mjs'), 'export default "first"'),
    writeFile(join(nested, 'echo.handler.mjs'), 'export default { operation: "echo" }'),
    writeFile(join(directory, 'ignored.controller.d.ts'), 'declare const unused: unknown'),
    writeFile(join(directory, 'ignored.controller.js.map'), '{}'),
    writeFile(join(directory, 'ignored.controller.cjs'), 'throw new Error("excluded extension")'),
    symlink(nested, alias, 'junction'),
  ])

  const imported = await loadModules({ directory: pathToFileURL(directory), suffix: 'controller' }, async (value) => {
    assert.equal(typeof value, 'string')
    return value
  })
  assert.deepEqual(imported, [
    {
      file: {
        absolutePath: join(nested, 'index.controller.mjs'),
        relativePath: 'nested/index.controller.mjs',
        stem: 'nested/index',
      },
      value: 'first',
    },
    {
      file: { absolutePath: join(directory, 'z %.controller.js'), relativePath: 'z %.controller.js', stem: 'z %' },
      value: 'last',
    },
  ])

  const handlers = await loadModules({ directory: alias, suffix: 'handler', extensions: ['.mjs'] }, (value) => value)
  assert.deepEqual(handlers, [
    {
      file: {
        absolutePath: join(alias, 'echo.handler.mjs'),
        relativePath: 'echo.handler.mjs',
        stem: 'echo',
      },
      value: { operation: 'echo' },
    },
  ])
})

test('matches literal suffixes inside hidden directories and imports only regular files', async (t) => {
  const directory = await tempDirectory(t)
  const hidden = join(directory, '.group')
  await mkdir(hidden)
  await Promise.all([
    writeFile(join(hidden, '[id].handler[dev].mjs'), 'export default "hidden"'),
    writeFile(join(directory, 'index.handlerd.mjs'), 'throw new Error("different suffix")'),
    writeFile(join(directory, 'ignored.handler[dev].MJS'), 'throw new Error("different extension")'),
    mkdir(join(directory, 'dir.handler[dev].mjs')),
  ])

  const modules = await loadModules({ directory, suffix: 'handler[dev]' }, (value) => value)
  assert.deepEqual(modules.map(({ file, value }) => [file.relativePath, value]), [
    ['.group/[id].handler[dev].mjs', 'hidden'],
  ])
})

test('rejects missing directories and files used as scan roots', async (t) => {
  const directory = await tempDirectory(t)
  const file = join(directory, 'file')
  await writeFile(file, '')

  await assert.rejects(
    loadModules({ directory: join(directory, 'missing'), suffix: 'handler' }, (value) => value),
    { code: 'ENOENT' },
  )
  await assert.rejects(loadModules({ directory: file, suffix: 'handler' }, (value) => value), { code: 'ENOTDIR' })
})

test('reports unreadable nested directories before importing matches', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const directory = await tempDirectory(t)
  const blocked = join(directory, 'blocked')
  await mkdir(blocked, { mode: 0o000 })
  const decode = t.mock.fn()
  try {
    await writeFile(join(directory, 'echo.handler.mjs'), 'export default "echo"')
    await assert.rejects(loadModules({ directory, suffix: 'handler' }, decode), { code: 'EACCES' })
    assert.equal(decode.mock.callCount(), 0)
  } finally {
    await chmod(blocked, 0o700)
  }
})

test('identifies a matching file that lacks a default export', async (t) => {
  const directory = await tempDirectory(t)
  await writeFile(join(directory, 'missing.handler.mjs'), 'export const handler = 1')

  await assert.rejects(
    loadModules({ directory, suffix: 'handler' }, (value) => value),
    /missing\.handler\.mjs.*default export/,
  )
})

test('keeps import and decoder causes with their file paths', async (t) => {
  const directory = await tempDirectory(t)
  await writeFile(join(directory, 'broken.import.mjs'), 'throw new Error("module initialization failed")')
  await writeFile(join(directory, 'invalid.handler.mjs'), 'export default null')
  const invalidHandler = new TypeError('expected a handler')

  await assert.rejects(loadModules({ directory, suffix: 'import' }, (value) => value), (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /broken\.import\.mjs/)
    assert.ok(error.cause instanceof Error)
    assert.equal(error.cause.message, 'module initialization failed')
    return true
  })
  await assert.rejects(loadModules({ directory, suffix: 'handler' }, () => { throw invalidHandler }), (error) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /invalid\.handler\.mjs/)
    assert.equal(error.cause, invalidHandler)
    return true
  })
})

test('parses index, static, parameter and terminal catch-all segments', () => {
  assert.deepEqual(parseFileRoute('index'), [])
  assert.deepEqual(parseFileRoute('users/[id]/index'), [
    { kind: 'static', value: 'users' },
    { kind: 'parameter', name: 'id' },
  ])
  assert.deepEqual(parseFileRoute('users/[id]/files/[...parts]'), [
    { kind: 'static', value: 'users' },
    { kind: 'parameter', name: 'id' },
    { kind: 'static', value: 'files' },
    { kind: 'catch-all', name: 'parts' },
  ])
})

test('maps grouped directories with a portable prefix and keeps a literal index in the prefix', () => {
  assert.deepEqual(parseFileRoute('(staff)/users/(shared)/[id]', { prefix: '/tenants/[tenant]/' }), [
    { kind: 'static', value: 'tenants' },
    { kind: 'parameter', name: 'tenant' },
    { kind: 'static', value: 'users' },
    { kind: 'parameter', name: 'id' },
  ])
  assert.deepEqual(parseFileRoute('(staff)/index', { prefix: '/api/index' }), [
    { kind: 'static', value: 'api' },
    { kind: 'static', value: 'index' },
  ])
  assert.deepEqual(parseFileRoute('files/[...parts]/(shared)/index'), [
    { kind: 'static', value: 'files' },
    { kind: 'catch-all', name: 'parts' },
  ])
})

test('rejects ambiguous file paths and parameter names', () => {
  for (const stem of [
    '../index', 'users//index', '/root', 'users/user-[id]', 'files/[[...parts]]', 'users/:id', '(staff)',
  ]) {
    assert.throws(() => parseFileRoute(stem), TypeError, stem)
  }
  assert.throws(() => parseFileRoute('files/[...parts]/edit'), /final segment/)
  assert.throws(() => parseFileRoute('users/[id]/[...id]'), /duplicate parameter/)
  assert.throws(() => parseFileRoute('users/[__proto__]'), /invalid parameter/)
  assert.throws(
    () => parseFileRoute('(staff)/[id]', { prefix: '/teams/[id]', source: '(staff)/[id].controller.mjs' }),
    /\(staff\)\/\[id\]\.controller\.mjs.*duplicate parameter/,
  )
})
