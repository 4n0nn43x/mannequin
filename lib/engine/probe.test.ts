import assert from 'node:assert/strict'
import { classify, fingerprint, fingerprintPlans, planOf } from './probe'

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

// several plans: each plan only shows its name, nothing common to all paid pages
const plan = (name: string) => page(name, `<p>Seats: ${name === 'Team' ? 10 : 1}</p>`)
const fp2 = fingerprintPlans('/billing', { Basic: [plan('Basic'), plan('Basic')], Team: [plan('Team'), plan('Team')] }, [free(), free()])!
assert.equal(planOf(plan('Team'), fp2), 'Team')
assert.equal(planOf(plan('Basic'), fp2), 'Basic')
assert.equal(classify(plan('Team'), fp2), 'paid')
assert.equal(classify(free(), fp2), 'free')
assert.equal(planOf(free(), fp2), null)
// monthly and yearly of the same tier look identical: no plan fingerprint, paid/free still works
const fp3 = fingerprintPlans('/billing', { PRO_M: [paid('May 1, 2026'), paid('May 1, 2026')], PRO_Y: [paid('May 1, 2026'), paid('May 1, 2026')] }, [free(), free()])!
assert.equal(fp3.plans, undefined)
assert.equal(classify(paid('June 2, 2026'), fp3), 'paid')
assert.equal(planOf(paid('June 2, 2026'), fp3), null)
console.log('probe ok')
