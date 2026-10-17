import assert from 'node:assert/strict'
import { classify, fingerprint } from './probe'

const page = (plan: string, extra: string) =>
  `<html><script>var csrf="${Math.random()}"</script><main><h1>Billing</h1><p>You are currently on the <strong>${plan}</strong> plan.</p>${extra}<footer>© 2026</footer></main></html>`
const paid = (d: string) => page('PRO', `<p>Your plan renews on ${d}.</p><button>Manage Subscription</button>`)
const free = () => page('Free', `<button>Upgrade to PRO</button>`)

const fp = fingerprint('/dashboard/billing', [paid('November 17, 2026'), paid('November 17, 2026')], [free(), free()])!
assert.ok(fp, 'paid and free pages differ')
assert.equal(classify(paid('December 18, 2026'), fp), 'paid') // date changed, still paid
assert.equal(classify(free(), fp), 'free')
assert.equal(classify('<html>Sign in</html>', fp), 'unknown') // redirected to login: never a verdict
assert.equal(fingerprint('/x', [free(), free()], [free(), free()]), null) // route does not discriminate
console.log('probe ok')
