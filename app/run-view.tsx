'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Row, RunEvent, Summary } from '@/lib/engine/run'
import { CLIENTS } from '@/lib/engine/timeline'

type Rec = { t: number; e: RunEvent }
type Step = Extract<RunEvent, { type: 'step' }>
type AgentEv = Extract<RunEvent, { type: 'agent' }>

const CELL: Record<string, string> = { green: 'bg-success', red: 'bg-danger', orange: 'bg-warning text-dark', grey: 'bg-secondary' }
const ok = (status: number) => status >= 200 && status < 300

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
    }
  }, [recs])

  const live = !ended && !v.summary
  return (
    <>
      <div className="d-flex align-items-center gap-3 mb-3">
        <h4 className="mb-0 text-white">{title}</h4>
        {live ? <span className="badge bg-info"><i className="bx bx-loader-alt bx-spin" /> running</span> : <span className="badge bg-light text-dark">finished</span>}
        <span className="text-white-50 text-truncate">{v.progress.filter((p) => p.type === 'phase').at(-1)?.text}</span>
      </div>
      {v.invalid.map((i, n) => (
        <div key={n} className="alert alert-warning text-dark"><i className="bx bx-error" /> <b>Inconclusive</b> (never reported as a bug): {i.reason}</div>
      ))}
      {v.summary && <Report s={v.summary} />}
      <div className="row">
        <div className="col-xl-7">
          <Customers rows={v.rows.filter((r) => r.pass === 'main')} />
          <Timeline steps={v.steps} />
        </div>
        <div className="col-xl-5"><AgentConsole events={v.agent} /></div>
      </div>
      <div className="row">
        <div className="col-xl-7"><Progress items={v.progress} live={live} /></div>
        <div className="col-xl-5"><Detected data={v.detected} fingerprint={v.fingerprint} /></div>
      </div>
    </>
  )
}

function Card({ title, icon, children, className = '' }: { title: string; icon: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`card radius-10 ${className}`}>
      <div className="card-header bg-transparent"><h6 className="mb-0 text-white"><i className={`bx ${icon}`} /> {title}</h6></div>
      <div className="card-body">{children}</div>
    </div>
  )
}

function Customers({ rows }: { rows: Row[] }) {
  return (
    <Card title="Customers" icon="bx-user-check">
      <div className="table-responsive">
        <table className="table align-middle mb-0 mq-table">
          <thead><tr><th>Customer</th><th>Stripe status</th><th>App shows</th><th>Expected</th><th>Verdict</th><th>History</th></tr></thead>
          <tbody>
            {CLIENTS.map((c) => {
              const mine = rows.filter((r) => r.id === c.id)
              const last = mine.at(-1)
              const reds = mine.filter((r) => r.cell === 'red')
              const red = reds.length > 0 // a leak stays loud even after the app finally cuts access
              return (
                <tr key={c.id} className={red ? 'mq-red' : ''}>
                  <td><div className="fw-bold">{c.id}</div><div className="small text-white-50">{c.label}</div></td>
                  <td>{last?.status ?? '...'}</td>
                  <td>{last ? <span className={`badge ${last.seen === 'paid' ? 'bg-primary' : 'bg-dark'}`}>{last.seen}</span> : '...'}</td>
                  <td className="small">{last?.expect ?? ''}</td>
                  <td>
                    {red ? <span className="badge bg-danger fs-6">RED</span> : last && <span className={`badge ${CELL[last.cell]}`}>{last.cell}</span>}
                    {red ? <div className="small text-white">leaked {reds[0].step}{reds.length > 1 ? ` to ${reds.at(-1)!.step}` : ''}</div> : last && <div className="small text-white-50">{last.step}</div>}
                    {red && <div className="small mq-excerpt">&ldquo;{reds[0].excerpt}&rdquo;</div>}
                  </td>
                  <td className="text-nowrap">{mine.map((r) => <span key={r.step} className={`mq-dot ${CELL[r.cell]}`} title={`${r.step}: Stripe ${r.status}, app ${r.seen}, ${r.cell}`} />)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Timeline({ steps }: { steps: Step[] }) {
  return (
    <Card title="Stripe test clock timeline" icon="bx-time-five">
      {(['main', 'patched'] as const).map((pass) => {
        const s = steps.filter((x) => x.pass === pass)
        if (!s.length) return null
        return (
          <div key={pass} className="mb-2">
            {pass === 'patched' && <div className="small text-white-50 mb-1">Patched re-run</div>}
            <div className="d-flex gap-2 overflow-auto pb-2">
              {s.map((x) => (
                <div key={x.name} className="mq-step">
                  <div className="fw-bold text-white">{x.name}</div>
                  <div className="small text-white-50">{x.advanceMs ? `advance ${(x.advanceMs / 1000).toFixed(1)} s` : 'start'}</div>
                  {x.actions.map((a) => <div key={a} className="badge bg-info text-wrap text-start my-1">{a}</div>)}
                  <div>{x.deliveries.map((d, i) => <span key={i} className={`badge me-1 mb-1 ${ok(d.status) ? 'bg-success' : 'bg-danger'}`}>{d.type} {d.status}</span>)}</div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      {!steps.length && <div className="text-white-50">Waiting for the first clock step...</div>}
    </Card>
  )
}

function AgentConsole({ events }: { events: AgentEv[] }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }) }, [events.length])
  return (
    <Card title="Agent console: it writes and runs its own code" icon="bx-terminal">
      <div ref={box} className="mq-console">
        {!events.length && <div className="text-white-50">The agent starts when the app needs seed.js and session.js.</div>}
        {events.map((a, i) => {
          const header = i === 0 || events[i - 1].task !== a.task
          const { kind, text } = a.event
          return (
            <div key={i}>
              {header && <div className="mq-task">## task: {a.task}</div>}
              {kind === 'think' && <div className="mq-think">{text}</div>}
              {kind === 'result' && <pre className="mq-result">{text.split('\n').slice(0, 10).join('\n')}</pre>}
              {kind === 'tool' && text.startsWith('write ') && (
                <>
                  <div className="mq-cmd">{text.split('\n')[0]}</div>
                  <pre className="mq-code">{text.split('\n').slice(1).join('\n')}</pre>
                </>
              )}
              {kind === 'tool' && !text.startsWith('write ') && <div className="mq-cmd">{text}</div>}
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
    <Card title="Phases" icon="bx-cube">
      <ul className="list-unstyled mb-0 mq-phases">
        {items.map((p, i) =>
          p.type === 'phase' ? (
            <li key={i} className={i === lastPhase && live ? 'text-white fw-bold' : 'text-white-50'}>
              <i className={`bx ${i === lastPhase && live ? 'bx-loader-alt bx-spin' : 'bx-check-circle'}`} /> {p.text}
            </li>
          ) : (
            <li key={i} className="small text-white-50 ps-4">{p.text}</li>
          ),
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
    <Card title="Detected" icon="bx-target-lock">
      <table className="table table-sm mb-2"><tbody>
        {rows.map(([k, val]) => <tr key={k}><td className="text-white-50">{k}</td><td><code className="text-white">{val ?? '...'}</code></td></tr>)}
      </tbody></table>
      {fingerprint && <div className="small text-white-50"><b className="text-white">Fingerprint</b> {fingerprint.replace(/^fingerprint on \S+: /, '')}</div>}
    </Card>
  )
}

function Report({ s }: { s: Summary }) {
  const firstRed = s.red.filter((r, i) => s.red.findIndex((x) => x.id === r.id) === i) // first red step per customer
  const label = s.verdict === 'bugs' ? `${firstRed.length} leaking customer${firstRed.length > 1 ? 's' : ''}` : s.verdict === 'clean' ? 'No leak found' : 'Inconclusive'
  return (
    <div className={`card radius-10 ${s.verdict === 'bugs' ? 'mq-report-red' : ''}`}>
      <div className="card-body">
        <h3 className="text-white"><i className={`bx ${s.verdict === 'bugs' ? 'bx-bug' : s.verdict === 'clean' ? 'bx-check-shield' : 'bx-error'}`} /> Verdict: {label}</h3>
        {firstRed.map((r) => (
          <div key={r.id} className="mb-2 fs-6">
            Stripe says <b>{r.status}</b>, your app still treats <b>{r.id}</b> ({CLIENTS.find((c) => c.id === r.id)?.label}) as <b>paid</b> at <b>{r.step}</b>.
            <div className="mq-excerpt">&ldquo;{r.excerpt}&rdquo;</div>
          </div>
        ))}
        {s.patch && (
          <div className="row mt-3">
            <div className="col-xl-8">
              <h6 className="text-white"><i className="bx bx-git-compare" /> Patch written by the agent</h6>
              <pre className="mq-console mq-diff">
                {s.patch.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'mq-add' : l.startsWith('-') && !l.startsWith('---') ? 'mq-del' : ''}>{l || ' '}</div>)}
              </pre>
            </div>
            <div className="col-xl-4">
              <h6 className="text-white">Proof: patched code, fresh CreateOS fork</h6>
              {s.patched ? (
                <div className={`p-3 radius-10 ${s.patched.cell === 'green' ? 'mq-proof-ok' : 'mq-report-red'}`}>
                  <div className="fs-5 text-white">{s.patched.id} at {s.patched.step}: <span className={`badge ${CELL[s.patched.cell]}`}>{s.patched.cell === 'red' ? 'RED' : s.patched.cell}</span></div>
                  <div className="text-white-50">Stripe {s.patched.status}, app shows {s.patched.seen} (expected {s.patched.expect})</div>
                  <div className="small mq-excerpt">&ldquo;{s.patched.excerpt}&rdquo;</div>
                </div>
              ) : <div className="text-white-50">The patched re-run did not complete (see phases).</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
