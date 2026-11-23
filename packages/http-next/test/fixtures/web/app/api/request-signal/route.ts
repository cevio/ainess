import { getHttpRequestSignal } from '@ainess/http/request-signal'

export const dynamic = 'force-dynamic'

let disconnected: Promise<void> | undefined

export async function GET(request: Request): Promise<Response> {
  if (new URL(request.url).searchParams.has('disconnected')) {
    if (!disconnected) return new Response('No streamed request', { status: 409 })
    await disconnected
    return new Response(null, { status: 204 })
  }

  const signal = getHttpRequestSignal()
  if (!signal) return new Response('Missing request signal', { status: 500 })

  disconnected = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('started'))
    },
  })
  return new Response(body)
}
