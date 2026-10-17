'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import Dummy from '../dummy'
import { clearRuns, myRuns, type MyRun } from '../my-runs'

export default function MyRunsPage() {
  const [runs, setRuns] = useState<MyRun[] | null>(null)
  useEffect(() => setRuns(myRuns()), [])
  return (
    <section className="card">
      <div className="card-h"><h2>My runs</h2><span className="sub">kept in this browser only, no account</span></div>
      <div className="card-b">
        {runs === null ? null : runs.length === 0 ? (
          <p className="muted">No run started from this browser yet. <Link href="/">Start a crash test</Link> or watch the <Link href="/replay/sample">demo replay</Link>.</p>
        ) : (
          <>
            <table className="track">
              <thead><tr><th /><th>Repo</th><th>Started</th><th>Verdict</th><th /></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={r.verdict === 'bugs' ? 'leak' : ''}>
                    <td style={{ width: 30 }}><Dummy size={16} state={r.verdict === 'bugs' ? 'red' : r.verdict === 'clean' ? 'green' : r.verdict ? 'grey' : 'idle'} /></td>
                    <td className="mono">{r.repo.replace(/^https:\/\/github\.com\//, '')}</td>
                    <td className="small muted">{new Date(r.at).toLocaleString()}</td>
                    <td>{r.verdict === 'bugs' ? <span className="chip c-red">{r.leaks ?? ''} leaking</span> : r.verdict === 'clean' ? <span className="chip c-green">no leak</span> : r.verdict ? <span className="chip c-grey">{r.verdict}</span> : <span className="chip c-grey">not finished</span>}</td>
                    <td><Link href={`/runs/${r.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">A run lives on the server until it restarts or is redeployed; older links may no longer open.</p>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => { clearRuns(); setRuns([]) }}>Clear history</button>
          </>
        )}
      </div>
    </section>
  )
}
