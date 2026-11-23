export async function POST(request: Request) {
  return Response.json(await request.json(), { headers: { 'set-cookie': 'echo=ok; Path=/; HttpOnly' } })
}

export function GET(request: Request) {
  return Response.json({ message: new URL(request.url).searchParams.get('message') })
}
