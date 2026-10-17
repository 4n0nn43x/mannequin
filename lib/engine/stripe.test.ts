import assert from 'node:assert/strict'
import { intervalOf, plansFrom } from './stripe'

assert.deepEqual(plansFrom(['STRIPE_PRO_MONTHLY_PLAN_ID']), [{ env: 'STRIPE_PRO_MONTHLY_PLAN_ID', tier: 'PRO' }]) // taxonomy
assert.deepEqual(plansFrom([]), [{ env: 'STRIPE_PRO_MONTHLY_PLAN_ID', tier: 'PRO' }])
const p = plansFrom(['STRIPE_TEAM_PRICE_ID', 'STRIPE_PRICE_ID_BASIC', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRO_YEARLY_PRICE_ID', 'STRIPE_PRO_MONTHLY_PRICE_ID'])
assert.deepEqual(p.map((x) => x.tier), ['BASIC', 'PRO', 'PRO', 'TEAM']) // cheapest first, secrets dropped
assert.equal(intervalOf('STRIPE_PRO_YEARLY_PRICE_ID'), 'year')
assert.equal(intervalOf('STRIPE_PRO_MONTHLY_PLAN_ID'), 'month')
console.log('plans ok')
