import assert from 'node:assert/strict'
import test from 'node:test'
import { httpNext } from '@ainess/http-next'

test('Koa-first routing rejects an API prefix supplied by a JavaScript config', () => {
  assert.throws(() => {
    // @ts-expect-error JavaScript can pass fields disallowed by the option type.
    httpNext({ routing: 'koa-first', apiPrefix: '/api' })
  }, { name: 'TypeError', message: /apiPrefix.*prefix routing/ })
})
