// Stripe side of a run: test clocks, customers, subscriptions, the scripted life events, cleanup.
// Deterministic, no LLM. Uses the user's TEST key only.
import Stripe from 'stripe'
import { TRIAL_DAYS, type Action, type ClientId } from './timeline'

export type Sub = { id: ClientId; email: string; customer?: string; sub?: string; clock?: string; periodEnd?: number; price?: string; next?: string }
/** One app plan = one env var holding a Stripe price id (e.g. STRIPE_PRO_MONTHLY_PLAN_ID). tier groups monthly/yearly. */
export type Plan = { env: string; tier: string }
export type Interval = 'month' | 'year'

// ponytail: tier order guessed from common plan names (unknown names sit in the middle, in detection order)
const TIER_ORDER = ['free', 'hobby', 'starter', 'basic', 'standard', 'plus', 'pro', 'premium', 'team', 'business', 'growth', 'scale', 'enterprise']

/** Plan env var names -> plans, cheapest tier first. No plan found: the single paid plan Mannequin always injected. */
export function plansFrom(names: string[]): Plan[] {
  const envs = [...new Set(names)].filter((n) => !/_(KEY|SECRET|URL)$|TABLE|PORTAL/.test(n))
  if (!envs.length) return [{ env: 'STRIPE_PRO_MONTHLY_PLAN_ID', tier: 'PRO' }]
  const tierOf = (env: string) => env.replace(/^.*?STRIPE_/, '').replace(/(^|_)(PRICE|PLAN|ID|MONTHLY|YEARLY|ANNUAL|MONTH|YEAR)(?=_|$)/g, '').replace(/^_+|_+$/g, '') || 'PAID'
  const rank = (tier: string) => { const i = TIER_ORDER.findIndex((n) => tier.toLowerCase().includes(n)); return i < 0 ? 6.5 : i }
  return envs.map((env) => ({ env, tier: tierOf(env) })).sort((a, b) => rank(a.tier) - rank(b.tier))
}

export const intervalOf = (env: string): Interval => (/YEAR|ANNUAL/.test(env) ? 'year' : 'month')

export function stripeFor(key: string) {
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('Mannequin only accepts Stripe TEST keys (sk_test_ or rk_test_)')
  return new Stripe(key)
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

/** plans: the app's plans, cheapest tier first (one test price each, at the same interval so clocks advance together).
 * Every customer is on the first plan, except P2 and S7 (most expensive tier) when the app has several tiers. */
/** created is filled as objects are made, so a failure half-way still cleans them up. */
export async function setup(stripe: Stripe, runId: string, t0: number, plans: Plan[], interval: Interval, created: { clocks?: string[]; prices?: string[]; product?: string }) {
  const tiers = [...new Set(plans.map((p) => p.tier))]
  const multi = tiers.length > 1
  const product = await stripe.products.create({ name: 'Mannequin test plan', metadata: { mannequin: runId } })
  created.product = product.id
  created.prices = []
  created.clocks = []
  const prices: Record<string, string> = {} // env var -> price id
  for (const p of plans) {
    const amount = 1000 * (tiers.indexOf(p.tier) + 1) // price order = tier order
    prices[p.env] = (await stripe.prices.create({ product: product.id, unit_amount: amount, currency: 'usd', recurring: { interval }, nickname: p.env })).id
    created.prices.push(prices[p.env])
  }
  const priceOf = (tier: string) => prices[plans.find((p) => p.tier === tier)!.env]
  const low = priceOf(tiers[0]), high = priceOf(tiers.at(-1)!)
  // at most 3 customers per test clock (Stripe limit)
  const clockIds = multi ? (['A', 'B', 'C', 'D'] as const) : (['A', 'B', 'C'] as const)
  const clocks: Record<string, string> = {}
  for (const k of clockIds) created.clocks.push(clocks[k] = (await stripe.testHelpers.testClocks.create({ frozen_time: t0, name: `mannequin-${runId}-${k}` })).id)
  const subs: Sub[] = [{ id: 'free_control', email: `free_control+${runId}@mannequin.test` }]
  const plan: [ClientId, string, string][] = [['S1', 'A', low], ['S2', 'A', low], ['S3', 'A', low], ['S4', 'B', low], ['S5', 'B', low], ['S6', 'C', low], ['S8', 'C', low]]
  if (multi) plan.push(['P2', 'D', high], ['S7', 'D', high])
  for (const [id, clock, price] of plan) {
    const email = `${id.toLowerCase()}+${runId}@mannequin.test`
    // S5: free trial, no card (Stripe cancels it when the trial ends). S6: trial with a card that declines at trial end.
    const trial = id === 'S5' || id === 'S6'
    const card = id === 'S5' ? null : id === 'S6' ? 'pm_card_chargeCustomerFail' : 'pm_card_visa'
    // card as the CUSTOMER default, never on the subscription: S2's dead card must be the one charged later
    const c = await stripe.customers.create({
      email, test_clock: clocks[clock], metadata: { mannequin: runId },
      ...(card ? { payment_method: card, invoice_settings: { default_payment_method: card } } : {}),
    })
    const s = await stripe.subscriptions.create({
      customer: c.id, items: [{ price }],
      ...(id === 'S5' ? { trial_period_days: TRIAL_DAYS, trial_settings: { end_behavior: { missing_payment_method: 'cancel' } } } : {}),
      ...(id === 'S6' ? { trial_period_days: TRIAL_DAYS } : {}),
    })
    if (s.status !== (trial ? 'trialing' : 'active')) throw new Error(`${id} subscription is ${s.status}`)
    subs.push({ id, email, customer: c.id, sub: s.id, clock: clocks[clock], periodEnd: s.items.data[0].current_period_end, price, ...(id === 'S7' ? { next: low } : {}) })
  }
  const first = await stripe.subscriptions.retrieve(subs[1].sub!)
  const E = first.items.data[0].current_period_end // end of the first paid period
  const tierOfPrice = Object.fromEntries(plans.map((p) => [prices[p.env], p.tier]))
  return { product, prices, tiers, tierOfPrice, clocks: Object.values(clocks), subs, E, multi }
}

export async function advance(stripe: Stripe, clocks: string[], to: number) {
  await Promise.all(clocks.map((c) => stripe.testHelpers.testClocks.advance(c, { frozen_time: to })))
  const started = Date.now()
  for (;;) {
    const st = await Promise.all(clocks.map((c) => stripe.testHelpers.testClocks.retrieve(c)))
    if (st.some((c) => c.status === 'internal_failure')) throw new Error('Stripe test clock internal_failure')
    if (st.every((c) => c.status === 'ready')) return Date.now() - started
    await sleep(1500)
  }
}

export async function act(stripe: Stripe, action: Action, subs: Sub[]) {
  const by = (id: ClientId) => subs.find((s) => s.id === id)!
  if (action === 'kill_card_S2' || action === 'kill_card_S8') {
    const id = action === 'kill_card_S2' ? 'S2' : 'S8'
    const s = by(id)
    const dead = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: s.customer! })
    await stripe.customers.update(s.customer!, { invoice_settings: { default_payment_method: dead.id } })
    return `${id}: card replaced by one that declines at the next charge`
  }
  if (action === 'fix_card_S8') {
    const s8 = by('S8')
    const good = await stripe.paymentMethods.attach('pm_card_visa', { customer: s8.customer! })
    await stripe.customers.update(s8.customer!, { invoice_settings: { default_payment_method: good.id } })
    const [inv] = (await stripe.invoices.list({ subscription: s8.sub!, status: 'open', limit: 1 })).data
    if (inv) await stripe.invoices.pay(inv.id!, { payment_method: good.id })
    return `S8: new working card${inv ? `, open invoice paid (${(inv.amount_due / 100).toFixed(2)} ${inv.currency.toUpperCase()})` : ', no open invoice to pay'}`
  }
  if (action === 'refund_cancel_S3') {
    const s3 = by('S3')
    const pi = await firstPaymentIntent(stripe, s3)
    const refund = await stripe.refunds.create({ payment_intent: pi })
    await stripe.subscriptions.cancel(s3.sub!)
    return `S3: refunded ${(refund.amount / 100).toFixed(2)} ${refund.currency.toUpperCase()}, subscription canceled`
  }
  if (action === 'change_plan_S7') {
    const s7 = by('S7')
    const sub = await stripe.subscriptions.retrieve(s7.sub!)
    // immediate switch, no proration: from now on Stripe bills the cheaper plan
    await stripe.subscriptions.update(s7.sub!, { items: [{ id: sub.items.data[0].id, price: s7.next! }], proration_behavior: 'none' })
    return 'S7: switched to the cheaper plan'
  }
  const s4 = by('S4')
  await stripe.subscriptions.update(s4.sub!, { cancel_at_period_end: true })
  return 'S4: cancel at period end'
}

async function firstPaymentIntent(stripe: Stripe, s: Sub): Promise<string> {
  const [charge] = (await stripe.charges.list({ customer: s.customer!, limit: 1 })).data
  if (charge?.payment_intent) return typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent.id
  const [inv] = (await stripe.invoices.list({ subscription: s.sub!, limit: 1 })).data
  const [pay] = (await stripe.invoicePayments.list({ invoice: inv.id! })).data
  const pi = pay?.payment?.payment_intent
  if (!pi) throw new Error('could not find the first payment of S3 to refund')
  return typeof pi === 'string' ? pi : pi.id
}

/** Status and the moment Stripe says the subscription died (seconds, Stripe's own clock). */
export async function status(stripe: Stripe, s: Sub): Promise<{ status: string; deadAt: number | null; price: string | null }> {
  if (!s.sub) return { status: 'none', deadAt: null, price: null }
  const sub = await stripe.subscriptions.retrieve(s.sub)
  return { status: sub.status, deadAt: sub.ended_at ?? null, price: sub.items.data[0]?.price.id ?? null }
}

export async function webhookEndpoint(stripe: Stripe, url: string, apiVersion: string) {
  // pinned to the APP's API version: events must have the shapes the app's handler reads
  return stripe.webhookEndpoints.create({ url, enabled_events: ['*'], api_version: apiVersion as Stripe.WebhookEndpointCreateParams.ApiVersion })
}

export async function cleanup(stripe: Stripe, r: { endpoint?: string; clocks?: string[]; prices?: string[]; product?: string }) {
  const tryIt = (p: Promise<unknown>) => p.catch(() => undefined)
  if (r.endpoint) await tryIt(stripe.webhookEndpoints.del(r.endpoint))
  for (const c of r.clocks ?? []) await tryIt(stripe.testHelpers.testClocks.del(c)) // deletes its customers + subscriptions
  for (const p of r.prices ?? []) await tryIt(stripe.prices.update(p, { active: false }))
  if (r.product) await tryIt(stripe.products.update(r.product, { active: false }))
}
