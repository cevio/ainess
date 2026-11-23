import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

export const dir = fileURLToPath(new URL('./web/', import.meta.url))
export const dev = process.env.AINESS_TEST_NEXT_PRODUCTION !== '1'
process.env.NEXT_TELEMETRY_DISABLED ??= '1'

/**
 * @param {string} origin
 * @param {string} html
 */
export async function submitServerAction(origin, html) {
  const action = html.match(/name="(\$ACTION_ID_[^"]+)"/)?.[1]
  assert.ok(action, 'Next should render the Server Action form field')
  const form = new FormData()
  form.set(action, '')
  form.set('message', 'from Server Action')
  const submitted = await fetch(origin, { method: 'POST', headers: { origin }, body: form, redirect: 'manual' })
  assert.equal(submitted.status, 303)
  const location = submitted.headers.get('location')
  assert.ok(location)
  assert.deepEqual(await (await fetch(new URL(location, origin))).json(), { message: 'from Server Action' })
}
