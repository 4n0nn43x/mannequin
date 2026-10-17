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
    <form onSubmit={submit} className="form">
      <div className="form-row">
        <div className="field">
          <label htmlFor="repo">GitHub repo</label>
          <input id="repo" name="repo" defaultValue="https://github.com/shadcn-ui/taxonomy" required />
        </div>
        <div className="field">
          <label htmlFor="stripeKey">Stripe test key</label>
          <input id="stripeKey" name="stripeKey" type="password" placeholder="sk_test_..." autoComplete="off" required />
          <div className="hint">Test keys only (sk_test_ or rk_test_), never stored.</div>
        </div>
      </div>
      <details>
        <summary>Advanced</summary>
        <div className="field" style={{ marginTop: 10, maxWidth: 420 }}>
          <label htmlFor="route">Probe route (optional)</label>
          <input id="route" name="route" placeholder="/dashboard/billing" />
          <div className="hint">The page that shows paid vs free. Detected automatically if empty.</div>
        </div>
      </details>
      {error && <div className="alert bad">{error}</div>}
      <div>
        <button className="btn" disabled={busy}>{busy ? <span className="spin" /> : <span className="target" aria-hidden />} Start the crash test</button>
      </div>
    </form>
  )
}
