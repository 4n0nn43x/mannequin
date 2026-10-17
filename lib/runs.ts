// In-memory run registry for the web app: one run at a time, extra runs wait FIFO. Events are replayable over SSE.
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { redact } from './engine/agent'
import { run, type RunEvent, type RunInput } from './engine/run'

export type Rec = { t: number; e: RunEvent }
type Listener = (r: Rec | null) => void // null = run finished
type RunState = { events: Rec[]; done: boolean; listeners: Set<Listener> }

// globalThis survives dev hot reloads. ponytail: runs live in memory forever, add eviction if the server runs for days.
const g = globalThis as unknown as { mq?: { runs: Map<string, RunState>; tail: Promise<unknown>; pending: number } }
const store = (g.mq ??= { runs: new Map(), tail: Promise.resolve(), pending: 0 })

export const getRun = (id: string) => store.runs.get(id)

export function startRun(input: RunInput): string {
  const id = randomUUID()
  const state: RunState = { events: [], done: false, listeners: new Set() }
  store.runs.set(id, state)
  const t0 = Date.now()
  const key = input.stripeKey
  const emit = (e: RunEvent) => {
    const s = JSON.stringify(e)
    if (s.includes(key)) e = JSON.parse(s.split(key).join('sk_test_***')) // the key never reaches a browser
    const rec = { t: Date.now() - t0, e }
    state.events.push(rec)
    mkdir('runs', { recursive: true }).then(() => appendFile(`runs/web-${id}.events.jsonl`, JSON.stringify(rec) + '\n')).catch(() => {}) // replayable at /replay/web-<id>
    for (const l of state.listeners) l(rec)
  }
  const ahead = store.pending++
  emit({ type: 'log', text: ahead ? `queued: position ${ahead} (one run at a time)` : 'queued: starting now' })
  store.tail = store.tail.then(async () => {
    try {
      await run(input, emit)
    } catch (err) {
      const reason = `run failed: ${redact((err as Error).message ?? String(err)).slice(0, 400)}`
      emit({ type: 'invalid', reason })
      emit({ type: 'done', summary: { verdict: 'inconclusive', red: [], rows: [] } })
    } finally {
      store.pending--
      state.done = true
      for (const l of state.listeners) l(null)
      state.listeners.clear()
    }
  })
  return id
}

/** Server-Sent Events response. `start` sends records and returns an unsubscribe function. */
export function sse(req: Request, start: (send: (r: Rec) => void, close: () => void) => (() => void) | void) {
  const enc = new TextEncoder()
  let close = () => {}
  const stream = new ReadableStream({
    start(c) {
      let closed = false
      let stop: (() => void) | void
      const write = (s: string) => { if (!closed) try { c.enqueue(enc.encode(s)) } catch {} }
      const hb = setInterval(() => write(': hb\n\n'), 15_000)
      close = () => {
        if (closed) return
        write('event: end\ndata: {}\n\n') // tells EventSource not to reconnect
        closed = true
        clearInterval(hb)
        stop?.()
        try { c.close() } catch {}
      }
      req.signal.addEventListener('abort', () => close())
      stop = start((r) => write(`data: ${JSON.stringify(r)}\n\n`), close)
      if (closed) stop?.()
    },
    cancel() { close() },
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } })
}
