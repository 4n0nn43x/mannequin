'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Row, RunEvent, Summary } from '@/lib/engine/run'
import { CLIENTS, DAY, timeline } from '@/lib/engine/timeline'
import Dummy from './dummy'

type Rec = { t: number; e: RunEvent }
type Step = Extract<RunEvent, { type: 'step' }>
type AgentEv = Extract<RunEvent, { type: 'agent' }>

const ok = (status: number) => status >= 200 && status < 300
const TOTAL_STEPS = timeline(0, 30 * DAY).length // same count whatever t0 and E are

export default function RunView({ src, title }: { src: string; title: string }) {
  const [recs, setRecs] = useState<Rec[]>([])
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    const es = new EventSource(src)
    es.onopen = () => setRecs([]) // the server replays everything on (re)connect
    es.onmessage = (m) => {
      const r = JSON.parse(m.data) as Rec
      setRecs((prev) => [...prev, r])
      if (r.e.type === 'done') { es.close(); setEnded(true) }
    }
    es.addEventListener('end', () => { es.close(); setEnded(true) })
    return () => es.close()
  }, [src])

  const v = useMemo(() => {
    const ev = recs.map((r) => r.e)
    const of = <K extends RunEvent['type']>(k: K) => ev.filter((e): e is Extract<RunEvent, { type: K }> => e.type === k)
    return {
      progress: ev.filter((e) => e.type === 'phase' || e.type === 'log') as Extract<RunEvent, { type: 'phase' | 'log' }>[],
      detected: of('detected')[0]?.data,
      fingerprint: of('log').filter((l) => l.text.startsWith('fingerprint on ')).at(-1)?.text,
      steps: of('step'),
      rows: of('row').map((r) => r.row),
      agent: of('agent'),
      invalid: of('invalid'),
      summary: of('done')[0]?.summary,
      elapsed: recs.at(-1)?.t ?? 0,
    }
  }, [recs])

  const live = !ended && !v.summary
  const main = v.steps.filter((s) => s.pass === 'main')
  const hooks = v.steps.flatMap((s) => s.deliveries)
  const leaks = new Set(v.rows.filter((r) => r.cell === 'red').map((r) => r.id)).size
  const phase = v.progress.filter((p) => p.type === 'phase').at(-1)?.text
  return (
    <div className="grid">
      <div className="card" style={{ overflow: 'hidden' }}>
        {(live || leaks > 0) && <div className={`hazard ${live ? 'moving' : ''}`} />}
        <div className="hud">
          <Dummy size={36} walk={live} state={leaks ? 'red' : 'idle'} />
          <div style={{ minWidth: 0 }}>
            <h1>{title}</h1>
            <div className="small" style={{ marginTop: 4 }}>
              {live ? <span className="chip c-red"><span className="dot pulse" /> Live</span> : <span className="chip c-grey">Finished</span>}
            </div>
          </div>
          <div className="phase" title={phase}>{phase ?? 'Connecting...'}</div>
          <div className="meters">
            <div className="meter"><b>T+{clock(v.elapsed)}</b><span>Elapsed</span></div>
            <div className="meter"><b>{main.length}/{TOTAL_STEPS}</b><span>Clock steps</span></div>
            <div className="meter"><b>{hooks.length}</b><span>Webhooks{hooks.some((d) => !ok(d.status)) ? `, ${hooks.filter((d) => !ok(d.status)).length} failed` : ''}</span></div>
            <div className={`meter ${leaks ? 'bad' : ''}`}><b>{leaks}</b><span>Leaking</span></div>
          </div>
        </div>
      </div>
      {v.invalid.map((i, n) => (
        <div key={n} className="alert warn"><b>Inconclusive</b> (never reported as a bug): {i.reason}</div>
      ))}
      {v.summary && <Report s={v.summary} />}
      <div className="grid split">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Track rows={v.rows.filter((r) => r.pass === 'main')} />
          <Timeline steps={v.steps} />
        </div>
        <AgentConsole events={v.agent} />
      </div>
      <div className="grid split">
        <Progress items={v.progress} live={live} />
        <Detected data={v.detected} fingerprint={v.fingerprint} />
      </div>
    </div>
  )
}

const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-h"><h2>{title}</h2>{sub && <span className="sub">{sub}</span>}</div>
      <div className="card-b">{children}</div>
    </section>
  )
}

function Track({ rows }: { rows: Row[] }) {
  return (
    <Card title="Test track" sub="one lane per customer, one cell per clock step">
      <div style={{ overflowX: 'auto' }}>
        <table className="track">
          <thead><tr><th>Customer</th><th>Stripe</th><th>App shows</th><th>Expected</th><th>Verdict</th><th>Track</th></tr></thead>
          <tbody>
            {CLIENTS.map((c) => {
              const mine = rows.filter((r) => r.id === c.id)
              const last = mine.at(-1)
              const reds = mine.filter((r) => r.cell === 'red')
              const red = reds.length > 0 // a leak stays loud even after the app finally cuts access
              return (
                <tr key={c.id} className={red ? 'leak' : ''}>
                  <td><div className="lane-id">{c.id}</div><div className="lane-label">{c.label}</div></td>
                  <td className="mono small">{last?.status ?? '...'}</td>
                  <td>{last ? <span className={`chip ${last.seen === 'paid' ? 'c-paid' : last.seen === 'free' ? 'c-free' : 'c-grey'}`}>{last.seen}</span> : '...'}</td>
                  <td className="mono small">{last?.expect ?? ''}</td>
                  <td>
                    {red ? <span className="chip c-red">Red</span> : last && <span className={`chip c-${last.cell}`}>{last.cell}</span>}
                    {red ? <div className="small" style={{ marginTop: 4 }}>leaked {reds[0].step}{reds.length > 1 ? ` to ${reds.at(-1)!.step}` : ''}</div> : last && <div className="small muted" style={{ marginTop: 4 }}>{last.step}</div>}
                    {red && <div className="small quote">&ldquo;{reds[0].excerpt}&rdquo;</div>}
                  </td>
                  <td>
                    <div className="lane">
                      {mine.map((r) => <span key={r.step} className={`cell new ${r.cell}`} title={`${r.step}: Stripe ${r.status}, app ${r.seen}, ${r.cell}`} />)}
                      <span className="runner"><Dummy size={16} state={red ? 'red' : last?.cell ?? 'idle'} walk={!!last && mine.length < TOTAL_STEPS} /></span>
                      {Array.from({ length: Math.max(0, TOTAL_STEPS - mine.length) }, (_, i) => <span key={`e${i}`} className="cell" />)}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />as expected</span>
        <span><i style={{ background: 'var(--bad)' }} />paid access while Stripe says dead for over 24 h</span>
        <span><i style={{ background: 'var(--warn)' }} />access cut while paying</span>
        <span><i style={{ background: 'var(--grey)' }} />page unreadable</span>
      </div>
    </Card>
  )
}

function Timeline({ steps }: { steps: Step[] }) {
  return (
    <Card title="Stripe test clock" sub="each advance, the life events played, the webhooks your app answered">
      {(['main', 'patched'] as const).map((pass) => {
        const s = steps.filter((x) => x.pass === pass)
        if (!s.length) return null
        return (
          <div key={pass} style={{ marginBottom: 10 }}>
            {pass === 'patched' && <div className="eyebrow" style={{ margin: '6px 0 8px' }}>Patched re-run</div>}
            <div className="clock">
              {s.map((x) => {
                const bad = x.deliveries.filter((d) => !ok(d.status)).length
                return (
                  <div key={x.name} className="tick">
                    <div className="name">{x.name}</div>
                    <div className="small muted">{x.advanceMs ? `advance ${(x.advanceMs / 1000).toFixed(1)} s` : 'start'}</div>
                    {x.actions.map((a) => <div key={a} className="action">{a}</div>)}
                    {x.deliveries.length > 0 && (
                      <details>
                        <summary>{x.deliveries.length} webhook{x.deliveries.length > 1 ? 's' : ''}{bad ? `, ${bad} failed` : ', all 2xx'}</summary>
                        <div className="hooks">{x.deliveries.map((d, i) => <span key={i} className={`hook ${ok(d.status) ? '' : 'ko'}`}>{d.type} {d.status}</span>)}</div>
                      </details>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      {!steps.length && <div className="muted">Waiting for the first clock step...</div>}
    </Card>
  )
}

function AgentConsole({ events }: { events: AgentEv[] }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }) }, [events.length])
  return (
    <Card title="Agent console" sub="it writes and runs its own code">
      <div ref={box} className="console">
        {!events.length && <div className="think">The agent starts when the app needs seed.js and session.js.</div>}
        {events.map((a, i) => {
          const header = i === 0 || events[i - 1].task !== a.task
          const { kind, text } = a.event
          return (
            <div key={i}>
              {header && <div className="task">## task: {a.task}</div>}
              {kind === 'think' && <div className="think">{text}</div>}
              {kind === 'result' && <pre className="result">{text.split('\n').slice(0, 10).join('\n')}</pre>}
              {kind === 'tool' && text.startsWith('write ') && (
                <>
                  <div className="cmd">{text.split('\n')[0]}</div>
                  <pre className="code">{text.split('\n').slice(1).join('\n')}</pre>
                </>
              )}
              {kind === 'tool' && !text.startsWith('write ') && <div className="cmd">{text}</div>}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Progress({ items, live }: { items: Extract<RunEvent, { type: 'phase' | 'log' }>[]; live: boolean }) {
  const lastPhase = items.findLastIndex((p) => p.type === 'phase')
  return (
    <Card title="Phases">
      <ul className="phases">
        {items.map((p, i) =>
          p.type === 'phase'
            ? <li key={i} className={`ph ${i === lastPhase && live ? 'now' : ''}`}>{p.text}</li>
            : <li key={i} className="log">{p.text}</li>,
        )}
      </ul>
    </Card>
  )
}

function Detected({ data, fingerprint }: { data?: Record<string, string>; fingerprint?: string }) {
  const rows: [string, string | undefined][] = [
    ['Webhook path', data?.webhookPath], ['Webhook handler', data?.handler], ['Stripe API version', data?.apiVersion],
    ['Auth', data?.auth], ['Probed route', fingerprint?.match(/^fingerprint on (\S+):/)?.[1] ?? (data?.route || undefined)],
  ]
  return (
    <Card title="Detected">
      <table className="kv"><tbody>
        {rows.map(([k, val]) => <tr key={k}><td>{k}</td><td><code>{val ?? '...'}</code></td></tr>)}
      </tbody></table>
      {fingerprint && <div className="small muted" style={{ marginTop: 10 }}><b style={{ color: 'var(--ink)' }}>Fingerprint</b> {fingerprint.replace(/^fingerprint on \S+: /, '')}</div>}
    </Card>
  )
}

function Report({ s }: { s: Summary }) {
  const firstRed = s.red.filter((r, i) => s.red.findIndex((x) => x.id === r.id) === i) // first red step per customer
  const label = s.verdict === 'bugs' ? `${firstRed.length} leaking customer${firstRed.length > 1 ? 's' : ''}` : s.verdict === 'clean' ? 'No leak found' : 'Inconclusive'
  const stamp = s.verdict === 'bugs' ? 'Leak found' : s.verdict === 'clean' ? 'Passed' : 'No verdict'
  return (
    <section className={`card verdict ${s.verdict}`}>
      <div className="card-b" style={{ paddingTop: 20 }}>
        <h2>Verdict: {label} <span className={`stamp ${s.verdict}`}>{stamp}</span></h2>
        {firstRed.map((r) => (
          <div key={r.id} className="leak">
            Stripe says <b>{r.status}</b>, your app still treats <b>{r.id}</b> ({CLIENTS.find((c) => c.id === r.id)?.label}) as <b>paid</b> at <b className="mono">{r.step}</b>.
            <div className="quote">&ldquo;{r.excerpt}&rdquo;</div>
          </div>
        ))}
        {s.patch && (
          <div className="grid split" style={{ marginTop: 20 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Patch written by the agent</div>
              <pre className="console diff">
                {s.patch.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>{l || ' '}</div>)}
              </pre>
            </div>
            <div>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Proof: patched code, fresh CreateOS fork</div>
              {s.patched ? (
                <div className={`proof ${s.patched.cell === 'green' ? 'ok' : 'ko'}`}>
                  <div className="big">{s.patched.id} at <span className="mono">{s.patched.step}</span> <span className={`chip c-${s.patched.cell}`}>{s.patched.cell === 'red' ? 'Red' : s.patched.cell}</span></div>
                  <div className="muted" style={{ marginTop: 6 }}>Stripe {s.patched.status}, app shows {s.patched.seen} (expected {s.patched.expect})</div>
                  <div className="small quote" style={{ color: 'inherit' }}>&ldquo;{s.patched.excerpt}&rdquo;</div>
                </div>
              ) : <div className="muted">The patched re-run did not complete (see phases).</div>}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
