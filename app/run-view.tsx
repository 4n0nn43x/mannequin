'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Row, RunEvent, Summary } from '@/lib/engine/run'
import { CLIENTS, DAY, timeline } from '@/lib/engine/timeline'
import Dummy, { type DummyState } from './dummy'
import { myRuns, saveRun } from './my-runs'

type Rec = { t: number; e: RunEvent }
type Step = Extract<RunEvent, { type: 'step' }>
type AgentEv = Extract<RunEvent, { type: 'agent' }>

const ok = (status: number) => status >= 200 && status < 300
const TOTAL_STEPS = timeline(0, 30 * DAY).length // same count whatever t0 and E are

/** runId: a live run started from this browser, so its verdict is saved in "My runs". */
export default function RunView({ src, title, runId }: { src: string; title: string; runId?: string }) {
  const [recs, setRecs] = useState<Rec[]>([])
  const [ended, setEnded] = useState(false)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    const es = new EventSource(src)
    es.onopen = () => setRecs([]) // the server replays everything on (re)connect
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) setGone(true) } // 404: the server no longer has this run
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

  const live = !ended && !v.summary && !gone
  useEffect(() => {
    const mine = runId && myRuns().find((r) => r.id === runId)
    if (mine && v.summary) saveRun({ ...mine, verdict: v.summary.verdict, leaks: new Set(v.summary.red.map((r) => r.id)).size })
  }, [runId, v.summary])
  if (gone && !recs.length) return <div className="alert warn">This run is no longer on the server (it restarted or was redeployed). Runs are kept in memory only.</div>
  const main = v.steps.filter((s) => s.pass === 'main')
  const hooks = v.steps.flatMap((s) => s.deliveries)
  const leaks = new Set(v.rows.filter((r) => r.cell === 'red').map((r) => r.id)).size
  const phase = v.progress.filter((p) => p.type === 'phase').at(-1)?.text
  const repo = v.progress.find((p) => p.type === 'log' && p.text.startsWith('repo '))?.text.slice(5)
  function pdf() {
    const t = document.title
    document.title = `Mannequin report ${repo?.replace(/^https:\/\/github\.com\//, '') ?? ''} ${new Date().toISOString().slice(0, 10)}`
    window.addEventListener('afterprint', () => { document.title = t }, { once: true }) // print() does not block everywhere
    window.print() // the browser saves it as a PDF, laid out by the print-only report below
  }
  return (
    <>
    {v.summary && <PrintReport s={v.summary} repo={repo} rows={v.rows.filter((r) => r.pass === 'main')} steps={v.steps} detected={v.detected} fingerprint={v.fingerprint} invalid={v.invalid.map((i) => i.reason)} />}
    <div className="grid no-print">
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
          {v.summary && <button className="btn" onClick={pdf}>Download PDF report</button>}
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
    </>
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

const STORY: Record<string, string> = {
  free_control: 'Never subscribes. Must always see the free plan, otherwise the whole run proves nothing.',
  S1: 'Pays every month with a good card. Must always see the paid plan.',
  S2: 'At t0+1d the card is swapped for one that declines. At renewal Stripe retries for about a week, then cancels.',
  S3: 'Refunded and canceled at t0+2d. Should lose paid access within 24 hours.',
  S4: 'Asks to cancel at period end on t0+5d. Keeps access until the end of the paid period, then loses it.',
  S5: '7-day free trial without a card. Stripe cancels it when the trial ends.',
  S6: '7-day trial with a card that declines at the first real charge. Stripe retries, then cancels.',
  S8: 'Same dead card as S2, but at E+4d, during the retries, puts in a working card and pays. Must get paid access back.',
  P2: 'Paid control on the other plan. Must always see that plan.',
  S7: 'Moves from the expensive plan to the cheap one at t0+2d. Must not keep the expensive plan.',
}

function Track({ rows }: { rows: Row[] }) {
  const [sel, setSel] = useState<string | null>(null)
  const lanes = CLIENTS.filter((c) => (rows.length ? rows.some((r) => r.id === c.id) : !c.multi)) // once probed: only the customers this run tested
  const firstRed = rows.find((r) => r.cell === 'red')?.id
  const open = sel ?? firstRed ?? null
  return (
    <Card title="Test track" sub="click a dummy to open its file">
      <div className="lanes">
        {lanes.map((c) => {
          const mine = rows.filter((r) => r.id === c.id)
          const last = mine.at(-1)
          const reds = mine.filter((r) => r.cell === 'red')
          const red = reds.length > 0 // a leak stays loud even after the app finally cuts access
          const leakingNow = last?.cell === 'red'
          const pos = mine.length ? ((mine.length - 0.5) / TOTAL_STEPS) * 100 : 0
          const state = red ? 'red' : last?.cell ?? 'idle'
          return (
            <button key={c.id} type="button" className={`lane ${red ? 'leak' : ''} ${open === c.id ? 'on' : ''}`} onClick={() => setSel(open === c.id ? '' : c.id)} aria-expanded={open === c.id}>
              <span className="who"><b className="mono">{c.id}</b><span>{c.label}</span></span>
              <span className="road">
                {mine.map((r, i) => <i key={r.step} className={`cone ${r.cell}`} style={{ left: `${((i + 0.5) / TOTAL_STEPS) * 100}%` }} title={`${r.step}: Stripe ${r.status}, app ${r.plan ?? r.seen}, ${r.cell}`} />)}
                <span className="flag" aria-hidden />
                <span className="runner" style={{ left: `${pos}%` }}>
                  {leakingNow && <span className="bubble">FREE RIDE!</span>}
                  <Dummy size={20} state={state as DummyState} walk={!!last && mine.length < TOTAL_STEPS && !leakingNow} />
                </span>
              </span>
              <span className="now">
                <span className="mono small">{last?.status ?? 'waiting'}</span>
                {last && <span className={`chip ${last.seen === 'paid' ? 'c-paid' : last.seen === 'free' ? 'c-free' : 'c-grey'}`}>{last.plan ?? last.seen}</span>}
                {red ? <span className="chip c-red">Red</span> : last && <span className={`chip c-${last.cell}`}>{last.cell}</span>}
              </span>
            </button>
          )
        })}
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--ok)' }} />as expected</span>
        <span><i style={{ background: 'var(--bad)' }} />paid access while Stripe says dead for over 24 h</span>
        <span><i style={{ background: 'var(--warn)' }} />access cut while paying</span>
        <span><i style={{ background: 'var(--grey)' }} />page unreadable</span>
      </div>
      {open && lanes.some((c) => c.id === open) && <DummyFile id={open} rows={rows.filter((r) => r.id === open)} />}
    </Card>
  )
}

function DummyFile({ id, rows }: { id: string; rows: Row[] }) {
  const reds = rows.filter((r) => r.cell === 'red')
  const state: DummyState = reds.length ? 'red' : (rows.at(-1)?.cell as DummyState) ?? 'idle'
  return (
    <div className="file">
      <div className="file-head">
        <Dummy size={56} state={state} walk={!reds.length && rows.length > 0 && rows.length < TOTAL_STEPS} />
        <div>
          <div className="eyebrow">Dummy file</div>
          <h3>{id}: {label(id)}</h3>
          <p className="muted small" style={{ margin: '4px 0 0' }}>{STORY[id]}</p>
          {reds.length > 0 && <p className="small" style={{ margin: '6px 0 0' }}><LeakSentence r={reds[0]} /> Leak from <b className="mono">{reds[0].step}</b> to <b className="mono">{reds.at(-1)!.step}</b>.</p>}
        </div>
      </div>
      {rows.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="track">
            <thead><tr><th>Step</th><th>Stripe</th><th>App shows</th><th>Expected</th><th>Verdict</th><th>Page evidence</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.step} className={r.cell === 'red' ? 'leak' : ''}>
                  <td className="mono">{r.step}</td>
                  <td className="mono small">{r.status}{r.stripePlan && <div className="muted">{r.stripePlan}</div>}</td>
                  <td><span className={`chip ${r.seen === 'paid' ? 'c-paid' : r.seen === 'free' ? 'c-free' : 'c-grey'}`}>{r.plan ?? r.seen}</span></td>
                  <td className="mono small">{r.expect}</td>
                  <td><span className={`chip c-${r.cell}`}>{r.cell}</span></td>
                  <td className="small muted">{r.excerpt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted small">Not probed yet.</p>}
    </div>
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
    ['Auth', data?.auth], ['Plans', data?.plans && `${data.plans}, ${data.interval}ly`], ['Probed route', fingerprint?.match(/^fingerprint on (\S+):/)?.[1] ?? (data?.route || undefined)],
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
            <LeakSentence r={r} />
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

const label = (id: string) => CLIENTS.find((c) => c.id === id)?.label
const isPlanLeak = (r: Row) => !!r.plan && !!r.stripePlan && r.plan !== r.stripePlan

function LeakSentence({ r }: { r: Row }) {
  return isPlanLeak(r)
    ? <>Stripe bills <b>{r.id}</b> ({label(r.id)}) on <b>{r.stripePlan}</b>, your app still shows <b>{r.plan}</b> at <b className="mono">{r.step}</b>.</>
    : <>Stripe says <b>{r.status}</b>, your app still treats <b>{r.id}</b> ({label(r.id)}) as <b>paid</b> at <b className="mono">{r.step}</b>.</>
}

/** A4 report, only visible when printing (Download PDF report). */
function PrintReport({ s, repo, rows, steps, detected, fingerprint, invalid }: { s: Summary; repo?: string; rows: Row[]; steps: Step[]; detected?: Record<string, string>; fingerprint?: string; invalid: string[] }) {
  const firstRed = s.red.filter((r, i) => s.red.findIndex((x) => x.id === r.id) === i)
  const main = steps.filter((x) => x.pass === 'main')
  const hooks = main.flatMap((x) => x.deliveries)
  const failed = hooks.filter((d) => !ok(d.status)).length
  const ids = CLIENTS.filter((c) => rows.some((r) => r.id === c.id))
  const title = s.verdict === 'bugs' ? `${firstRed.length} customer${firstRed.length > 1 ? 's keep' : ' keeps'} paid access without paying` : s.verdict === 'clean' ? 'No billing leak found' : 'Inconclusive run'
  return (
    <article className="print-only report">
      <header className="rp-head">
        <div className="rp-brand"><span className="target" aria-hidden /> Mannequin</div>
        <div className="rp-meta">Crash-test report<br />{new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}</div>
      </header>
      <div className="hazard" />
      <section className="rp-cover">
        <div className="eyebrow">Subscription access audit</div>
        <h1>{title}</h1>
        <p className="rp-repo mono">{repo}</p>
        <span className={`stamp ${s.verdict}`}>{s.verdict === 'bugs' ? 'Leak found' : s.verdict === 'clean' ? 'Passed' : 'No verdict'}</span>
        <div className="rp-kpis">
          <div><b>{ids.length}</b><span>test customers</span></div>
          <div><b>{main.length}</b><span>clock steps</span></div>
          <div><b>{hooks.length}</b><span>webhooks{failed ? `, ${failed} failed` : ', all 2xx'}</span></div>
          <div className={firstRed.length ? 'bad' : ''}><b>{firstRed.length}</b><span>leaking customers</span></div>
          <div className={s.patched?.cell === 'green' ? 'good' : ''}><b>{s.patched ? (s.patched.cell === 'green' ? 'Fixed' : 'Not fixed') : 'n/a'}</b><span>patch proof</span></div>
        </div>
      </section>

      {invalid.length > 0 && <section><h2>Why there is no verdict</h2><ul>{invalid.map((i) => <li key={i}>{i}</li>)}</ul></section>}

      {firstRed.length > 0 && (
        <section>
          <h2>Findings</h2>
          {firstRed.map((r) => {
            const reds = s.red.filter((x) => x.id === r.id)
            return (
              <div key={r.id} className="rp-finding">
                <h3>{r.id}: {label(r.id)}</h3>
                <p><LeakSentence r={r} /> The leak lasts from <b className="mono">{reds[0].step}</b> to <b className="mono">{reds.at(-1)!.step}</b> on the simulated clock.</p>
                <p className="quote">Page shown to the customer: &ldquo;{r.excerpt}&rdquo;</p>
                <p className="muted small">Impact: every customer in this situation keeps the paid features without paying until the app notices on its own. Your webhook endpoint answered 2xx to every event, so this does not show up in Stripe&rsquo;s delivery logs.</p>
              </div>
            )
          })}
        </section>
      )}

      {s.patch && (
        <section>
          <h2>Fix written by the agent</h2>
          <pre className="rp-diff">{s.patch.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>{l || ' '}</div>)}</pre>
          <h3>Proof</h3>
          {s.patched
            ? <p>Patch applied in a fresh CreateOS fork, app rebuilt, scenario replayed with new Stripe objects: <b>{s.patched.id}</b> at <b className="mono">{s.patched.step}</b>, Stripe <b>{s.patched.status}</b>, app shows <b>{s.patched.plan ?? s.patched.seen}</b>. Verdict <span className={`chip c-${s.patched.cell}`}>{s.patched.cell}</span></p>
            : <p className="muted">The patched re-run did not complete.</p>}
        </section>
      )}

      <section className="rp-break">
        <h2>Results, customer by clock step</h2>
        <table className="rp-matrix">
          <thead><tr><th>Customer</th>{main.map((x) => <th key={x.name}>{x.name}</th>)}</tr></thead>
          <tbody>
            {ids.map((c) => (
              <tr key={c.id}>
                <td><b>{c.id}</b><div className="muted">{c.label}</div></td>
                {main.map((x) => {
                  const r = rows.find((y) => y.id === c.id && y.step === x.name)
                  return <td key={x.name} className={r ? `m-${r.cell}` : ''} title={r?.status}>{r ? (r.plan ?? (r.seen === 'paid' ? 'P' : r.seen === 'free' ? 'F' : '?')) : ''}<div>{r?.status.replace('canceled', 'canc.').replace('trialing', 'trial').replace('past_due', 'p.due')}</div></td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted">Each cell: what the app showed (P paid, F free, or the plan) and what Stripe said. Green as expected, red paid access while Stripe says dead for over 24 h (or a more expensive plan than billed), orange access cut while paying, grey page unreadable.</p>

        <h2>Clock and webhooks</h2>
        <table className="rp-kv">
          <tbody>{main.map((x) => <tr key={x.name}><td className="mono">{x.name}</td><td>{x.actions.join('; ') || 'no action'}</td><td>{x.deliveries.length} webhooks{x.deliveries.some((d) => !ok(d.status)) ? `, ${x.deliveries.filter((d) => !ok(d.status)).length} failed` : ''}</td></tr>)}</tbody>
        </table>
      </section>

      <section>
        <h2>Method</h2>
        <ul className="small">
          <li>The app runs unchanged in an isolated CreateOS microVM forked from a snapshot, at Stripe&rsquo;s simulated time; webhooks are re-signed for that time so the app&rsquo;s own signature check accepts them.</li>
          <li>Each test customer is a real Stripe test-mode customer on a test clock; an agent seeds them in the app&rsquo;s database and logs in as them with the app&rsquo;s own auth library.</li>
          <li>The page {detected?.route || 'probed'} is classified by a differential fingerprint calibrated on paying and free controls, re-checked at every step.</li>
          <li>The verdict is fixed code, never the LLM: red only when Stripe itself says the subscription is dead (or on a cheaper plan) for more than 24 hours while the app still grants the paid access. Cutting access early is never red.</li>
        </ul>
        <table className="rp-kv">
          <tbody>
            {[['Webhook', detected?.webhookPath], ['Handler', detected?.handler], ['Stripe API version', detected?.apiVersion], ['Auth', detected?.auth], ['Plans', detected?.plans], ['Fingerprint', fingerprint?.replace(/^fingerprint on /, '')]].map(([k, val]) => <tr key={k}><td>{k}</td><td className="mono">{val ?? 'n/a'}</td></tr>)}
          </tbody>
        </table>
      </section>
      <footer className="rp-foot">Generated by Mannequin. Stripe test mode only: every Stripe object used by the run was created for it and removed at the end.</footer>
    </article>
  )
}
