import { getHttpRequestSignal } from '@ainess/http/request-signal'
import { redirect } from 'next/navigation.js'
import Counter from './counter.jsx'

export const dynamic = 'force-dynamic'

async function submit(form: FormData) {
  'use server'

  redirect(`/api/echo?message=${encodeURIComponent(String(form.get('message')))}`)
}

export default function Page() {
  return (
    <main data-request-signal={getHttpRequestSignal()?.aborted === false ? 'active' : 'missing'}>
      <h1>Next server component</h1>
      <Counter />
      <form action={submit}>
        <input name="message" />
        <button type="submit">Send</button>
      </form>
    </main>
  )
}
