import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sse, type Rec } from '@/lib/runs'
import { ASSETS } from '@/lib/engine/assets.gen'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Streams a recorded run (runs/<name>.events.jsonl, written by scripts/run.ts) with its original timing / speed. */
export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  if (!/^[\w.-]+$/.test(name)) return new Response('bad name', { status: 400 })
  const speed = Math.max(0.1, Number(new URL(req.url).searchParams.get('speed')) || 1)
  let recs: Rec[]
  try {
    const text = await readFile(join(process.cwd(), 'runs', `${name}.events.jsonl`), 'utf8').catch(() => ASSETS[`runs/${name}.events.jsonl`] ?? Promise.reject())
    recs = text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return new Response('unknown recording', { status: 404 })
  }
  return sse(req, (send, close) => {
    const timers = recs.map((r) => setTimeout(() => send(r), r.t / speed))
    timers.push(setTimeout(close, (recs.at(-1)?.t ?? 0) / speed + 50))
    return () => timers.forEach(clearTimeout)
  })
}
