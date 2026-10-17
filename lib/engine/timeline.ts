// The fixed policy (warrant): timeline, expectations and verdict are set before the first clock advance.
// Pure code, no I/O: the LLM never reads or writes any of this.

export const HOUR = 3600
export const DAY = 24 * HOUR
export const T = 24 * HOUR // tolerance after Stripe says the subscription is dead
export const TRIAL_DAYS = 7 // S5

export type ClientId = 'free_control' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S8' | 'P2' | 'S7'
export type Action = 'kill_card_S2' | 'refund_cancel_S3' | 'cancel_at_period_end_S4' | 'change_plan_S7' | 'kill_card_S8' | 'fix_card_S8'
export type Expect = 'MUST' | 'MAY' | 'MUST_NOT'
export type Seen = 'paid' | 'free' | 'unknown'
export type Cell = 'green' | 'red' | 'orange' | 'grey'

/** multi: only when the app has at least two plans (P2 = paid control on the second plan, S7 changes plan). */
export const CLIENTS: { id: ClientId; label: string; clock: 'A' | 'B' | 'C' | 'D' | null; multi?: true }[] = [
  { id: 'free_control', label: 'Free control (never paid)', clock: null },
  { id: 'S1', label: 'Paid control (normal renewal)', clock: 'A' },
  { id: 'S2', label: 'Card dies at renewal', clock: 'A' },
  { id: 'S3', label: 'Refunded, then canceled', clock: 'A' },
  { id: 'S4', label: 'Cancels at period end', clock: 'B' },
  { id: 'S5', label: 'Free trial, no card, expires', clock: 'B' },
  { id: 'S6', label: 'Trial with a card that declines', clock: 'C' },
  { id: 'S8', label: 'Card dies, then fixed', clock: 'C' },
  { id: 'P2', label: 'Paid control (other plan)', clock: 'D', multi: true },
  { id: 'S7', label: 'Downgrades to a cheaper plan', clock: 'D', multi: true },
]

export type Step = { name: string; at: number; actions: Action[] }

/** t0 = clock start, E = end of the first paid period (read from Stripe after the subscriptions exist). */
export function timeline(t0: number, E: number): Step[] {
  return [
    { name: 't0', at: t0, actions: [] },
    { name: 't0+1d', at: t0 + DAY, actions: ['kill_card_S2', 'kill_card_S8'] },
    { name: 't0+2d', at: t0 + 2 * DAY, actions: ['refund_cancel_S3', 'change_plan_S7'] },
    { name: 't0+3d', at: t0 + 3 * DAY + HOUR, actions: [] },
    { name: 't0+5d', at: t0 + 5 * DAY, actions: ['cancel_at_period_end_S4'] },
    { name: 'trial+1h', at: t0 + TRIAL_DAYS * DAY + HOUR, actions: [] }, // S5's trial just ended without a card
    { name: 'trial+26h', at: t0 + TRIAL_DAYS * DAY + T + 2 * HOUR, actions: [] }, // S5 dead for more than T
    { name: 'E-1h', at: E - HOUR, actions: [] },
    { name: 'E+1h', at: E + HOUR, actions: [] },
    { name: 'E+25h', at: E + T + HOUR, actions: [] },
    { name: 'E+4d', at: E + 4 * DAY, actions: ['fix_card_S8'] }, // S8 pays during the retries: access must come back
    { name: 'E+8d', at: E + 8 * DAY, actions: [] },
    { name: 'E+9d', at: E + 9 * DAY + HOUR, actions: [] },
  ]
}

const DEAD = new Set(['canceled', 'unpaid', 'incomplete_expired'])

/** Expected access from what Stripe itself says. deadSince = when Stripe's status turned dead (sim seconds). */
export function expected(status: string, now: number, deadSince: number | null): Expect {
  if (status === 'none') return 'MUST_NOT' // never paid
  if (status === 'active' || status === 'trialing') return 'MUST'
  if (DEAD.has(status)) return deadSince !== null && now - deadSince > T ? 'MUST_NOT' : 'MAY'
  return 'MAY' // past_due, incomplete, paused: product decision during retries
}

/** One-way verdict: cutting access early is never red. */
export function cell(exp: Expect, seen: Seen): Cell {
  if (seen === 'unknown') return 'grey'
  if (exp === 'MUST_NOT' && seen === 'paid') return 'red'
  if (exp === 'MUST' && seen === 'free') return 'orange'
  return 'green'
}

/** Plan level: the app shows a plan other than the one Stripe bills, for more than T after the change.
 * Showing a MORE expensive plan than the one paid for is a leak (red); a cheaper one is access cut while paying (orange).
 * rank = price order (higher = more expensive). */
export function planCell(c: Cell, now: number, changedAt: number | null, stripeRank: number | null, seenRank: number | null): Cell {
  if (c !== 'green' || changedAt === null || stripeRank === null || seenRank === null || stripeRank === seenRank) return c
  if (now - changedAt <= T) return c
  return seenRank > stripeRank ? 'red' : 'orange'
}

/** The controls must read as expected at every probe, otherwise the run proves nothing. */
export function controlsOk(rows: { id: ClientId; status: string; seen: Seen }[]): string | null {
  const free = rows.find((r) => r.id === 'free_control')
  if (free && free.seen !== 'free') return `free control seen as ${free.seen}`
  for (const id of ['S1', 'P2'] as const) {
    const paid = rows.find((r) => r.id === id)
    if (paid && paid.status === 'active' && paid.seen !== 'paid') return `paid control ${id} (active) seen as ${paid.seen}`
  }
  return null
}
