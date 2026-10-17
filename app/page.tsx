import NewRunForm from './new-run-form'
import Dummy from './dummy'
import { CLIENTS } from '@/lib/engine/timeline'

const HOW = [
  { title: 'One fresh VM per run', text: 'Your app is installed and built once in a CreateOS snapshot. Each run forks it into an isolated microVM with a public webhook URL for Stripe; egress is limited to Stripe (and Google Fonts for the rebuild).' },
  { title: 'The agent writes and runs its own code', text: 'An LLM agent reads your schema and auth setup, writes seed.js and session.js, runs them, and fixes them until it can log in as any customer.' },
  { title: 'Deterministic verdict, two controls', text: 'Stripe test clocks play the scenarios. A paying and a free control calibrate the probe at every step. Red only when Stripe says dead for over 24 h but your app still grants paid access.' },
]

export default function Home() {
  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">Crash-test lab for Stripe subscriptions</span>
          <h1>Send in the dummies. See who keeps paid access for free.</h1>
          <p className="lead">
            Mannequin boots your real app, lives fake customers through months of accelerated billing, logs in as each of them and tells you who keeps paid access without paying, with the fix proven on a fresh fork.
          </p>
          <NewRunForm />
        </div>
        <div className="card dummies" aria-label="The test customers">
          <div className="crowd">
            {CLIENTS.filter((c) => !c.multi).map((c, i) => <figure key={c.id}><Dummy size={i ? 34 : 40} walk />{c.id === 'free_control' ? 'free' : c.id}</figure>)}
          </div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Today&rsquo;s test subjects</div>
          <table>
            <tbody>
              {CLIENTS.map((c) => (
                <tr key={c.id}>
                  <td style={{ width: 34 }}><span className="target" aria-hidden style={{ width: 14, height: 14 }} /></td>
                  <td className="mono" style={{ fontWeight: 600, width: 110 }}>{c.id}</td>
                  <td className="muted">{c.label}{c.multi && <span className="small"> (apps with 2+ plans)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="steps3">
        {HOW.map((h, i) => (
          <div className="card card-b" key={h.title}>
            <div className="num">0{i + 1}</div>
            <h3>{h.title}</h3>
            <p>{h.text}</p>
          </div>
        ))}
      </section>
      <p className="foot">Stripe Projects + CreateOS Sandbox + Stripe test clocks</p>
    </>
  )
}
