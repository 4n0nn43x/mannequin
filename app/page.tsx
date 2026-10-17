import NewRunForm from './new-run-form'

const HOW = [
  { icon: 'bx-git-repo-forked', title: 'One fresh VM per run', text: 'Your app is installed and built once in a CreateOS snapshot. Each run forks it into an isolated microVM with a public webhook URL for Stripe; egress is limited to Stripe (and Google Fonts for the rebuild).' },
  { icon: 'bx-bot', title: 'The agent writes and runs its own code', text: 'An LLM agent reads your schema and auth setup, writes seed.js and session.js, runs them, and fixes them until it can log in as any customer.' },
  { icon: 'bx-check-shield', title: 'Deterministic verdict, two controls', text: 'Stripe test clocks play the scenarios. A paying and a free control calibrate the probe at every step. Red only when Stripe says dead for over 24 h but your app still grants paid access.' },
]

export default function Home() {
  return (
    <>
      <div className="card radius-10">
        <div className="card-body p-4">
          <h2 className="mb-2 text-white">Crash-test customers for your Stripe subscriptions</h2>
          <p className="mb-4 text-white-50 fs-6">
            Mannequin boots your real app, lives fake customers through months of accelerated billing, logs in as each of them and tells you who keeps paid access without paying, with the fix proven on a fresh fork.
          </p>
          <NewRunForm />
        </div>
      </div>
      <div className="row row-cols-1 row-cols-lg-3">
        {HOW.map((h) => (
          <div className="col" key={h.title}>
            <div className="card radius-10 h-100">
              <div className="card-body">
                <div className="d-flex align-items-center gap-2 mb-2"><i className={`bx ${h.icon} fs-3 text-white`} /><h6 className="mb-0 text-white">{h.title}</h6></div>
                <p className="mb-0 text-white-50">{h.text}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-center text-white-50 mt-2">Stripe Projects + CreateOS Sandbox + Stripe test clocks</p>
    </>
  )
}
