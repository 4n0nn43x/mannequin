'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export default function NewRunForm() {
  const router = useRouter()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const f = new FormData(e.currentTarget)
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: f.get('repo'), stripeKey: f.get('stripeKey'), route: f.get('route') }),
    }).catch(() => null)
    const data = res ? await res.json().catch(() => ({})) : {}
    if (res?.ok && data.id) return router.push(`/runs/${data.id}`)
    setError(data.error ?? 'Could not start the run')
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="row g-3">
      <div className="col-lg-6">
        <label className="form-label" htmlFor="repo"><i className="bx bxl-github" /> GitHub repo</label>
        <input id="repo" name="repo" className="form-control" defaultValue="https://github.com/shadcn-ui/taxonomy" required />
      </div>
      <div className="col-lg-6">
        <label className="form-label" htmlFor="stripeKey"><i className="bx bx-key" /> Stripe test key</label>
        <input id="stripeKey" name="stripeKey" type="password" className="form-control" placeholder="sk_test_..." autoComplete="off" required />
        <div className="form-text text-white-50">Test keys only (sk_test_ or rk_test_), never stored.</div>
      </div>
      <div className="col-12">
        <details>
          <summary className="text-white-50">Advanced</summary>
          <div className="mt-2 col-lg-6">
            <label className="form-label" htmlFor="route">Probe route (optional)</label>
            <input id="route" name="route" className="form-control" placeholder="/dashboard/billing" />
            <div className="form-text text-white-50">The page that shows paid vs free. Detected automatically if empty.</div>
          </div>
        </details>
      </div>
      {error && <div className="col-12"><div className="alert alert-danger mb-0">{error}</div></div>}
      <div className="col-12">
        <button className="btn btn-light px-5" disabled={busy}>
          {busy ? <i className="bx bx-loader-alt bx-spin" /> : <i className="bx bx-play-circle" />} Crash-test
        </button>
      </div>
    </form>
  )
}
