import { getRun, sse } from '@/lib/runs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const run = getRun((await params).id)
  if (!run) return new Response('unknown run', { status: 404 })
  return sse(req, (send, close) => {
    for (const r of run.events) send(r)
    if (run.done) return close()
    const l = (r: Parameters<typeof send>[0] | null) => (r ? send(r) : close())
    run.listeners.add(l)
    return () => run.listeners.delete(l)
  })
}
