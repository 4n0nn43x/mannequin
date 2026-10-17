// Stripe side of a run: test clocks, customers, subscriptions, the scripted life events, cleanup.
// Deterministic, no LLM. Uses the user's TEST key only.
import Stripe from 'stripe'
import type { Action, ClientId } from './timeline'

export type Sub = { id: ClientId; email: string; customer?: string; sub?: string; clock?: string }

export function stripeFor(key: string) {
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('Mannequin only accepts Stripe TEST keys (sk_test_ or rk_test_)')
  return new Stripe(key)
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

export async function setup(stripe: Stripe, runId: string, t0: number) {
  const product = await stripe.products.create({ name: 'Mannequin Pro', metadata: { mannequin: runId } })
  const price = await stripe.prices.create({ product: product.id, unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } })
  const clocks = {
    A: await stripe.testHelpers.testClocks.create({ frozen_time: t0, name: `mannequin-${runId}-A` }),
    B: await stripe.testHelpers.testClocks.create({ frozen_time: t0, name: `mannequin-${runId}-B` }),
  }
  const subs: Sub[] = [{ id: 'free_control', email: `free_control+${runId}@mannequin.test` }]
  for (const [id, clock] of [['S1', 'A'], ['S2', 'A'], ['S3', 'A'], ['S4', 'B']] as const) {
    const email = `${id.toLowerCase()}+${runId}@mannequin.test`
    // card as the CUSTOMER default, never on the subscription: S2's dead card must be the one charged later
    const c = await stripe.customers.create({
      email, test_clock: clocks[clock].id, payment_method: 'pm_card_visa',
      invoice_settings: { default_payment_method: 'pm_card_visa' }, metadata: { mannequin: runId },
    })
    const s = await stripe.subscriptions.create({ customer: c.id, items: [{ price: price.id }] })
    if (s.status !== 'active') throw new Error(`${id} subscription is ${s.status}, expected active`)
    subs.push({ id, email, customer: c.id, sub: s.id, clock: clocks[clock].id })
  }
  const first = await stripe.subscriptions.retrieve(subs[1].sub!)
  const E = first.items.data[0].current_period_end // end of the first paid period
  return { product, price, clocks: [clocks.A.id, clocks.B.id], subs, E }
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
  if (action === 'kill_card_S2') {
    const s2 = by('S2')
    const dead = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer: s2.customer! })
    await stripe.customers.update(s2.customer!, { invoice_settings: { default_payment_method: dead.id } })
    return 'S2: card replaced by one that declines at the next charge'
  }
  if (action === 'refund_cancel_S3') {
    const s3 = by('S3')
    const pi = await firstPaymentIntent(stripe, s3)
    const refund = await stripe.refunds.create({ payment_intent: pi })
    await stripe.subscriptions.cancel(s3.sub!)
    return `S3: refunded ${(refund.amount / 100).toFixed(2)} ${refund.currency.toUpperCase()}, subscription canceled`
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
export async function status(stripe: Stripe, s: Sub): Promise<{ status: string; deadAt: number | null }> {
  if (!s.sub) return { status: 'none', deadAt: null }
  const sub = await stripe.subscriptions.retrieve(s.sub)
  return { status: sub.status, deadAt: sub.ended_at ?? null }
}

export async function webhookEndpoint(stripe: Stripe, url: string, apiVersion: string) {
  // pinned to the APP's API version: events must have the shapes the app's handler reads
  return stripe.webhookEndpoints.create({ url, enabled_events: ['*'], api_version: apiVersion as Stripe.WebhookEndpointCreateParams.ApiVersion })
}

export async function cleanup(stripe: Stripe, r: { endpoint?: string; clocks?: string[]; price?: string; product?: string }) {
  const tryIt = (p: Promise<unknown>) => p.catch(() => undefined)
  if (r.endpoint) await tryIt(stripe.webhookEndpoints.del(r.endpoint))
  for (const c of r.clocks ?? []) await tryIt(stripe.testHelpers.testClocks.del(c)) // deletes its customers + subscriptions
  if (r.price) await tryIt(stripe.prices.update(r.price, { active: false }))
  if (r.product) await tryIt(stripe.products.update(r.product, { active: false }))
}
