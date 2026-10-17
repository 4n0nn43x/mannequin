// The fixed policy (warrant): timeline, expectations and verdict are set before the first clock advance.
// Pure code, no I/O: the LLM never reads or writes any of this.

export const HOUR = 3600
export const DAY = 24 * HOUR
export const T = 24 * HOUR // tolerance after Stripe says the subscription is dead
export const TRIAL_DAYS = 7 // S5

export type ClientId = 'free_control' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5'
export type Action = 'kill_card_S2' | 'refund_cancel_S3' | 'cancel_at_period_end_S4'
export type Expect = 'MUST' | 'MAY' | 'MUST_NOT'
export type Seen = 'paid' | 'free' | 'unknown'
export type Cell = 'green' | 'red' | 'orange' | 'grey'

export const CLIENTS: { id: ClientId; label: string; clock: 'A' | 'B' | null }[] = [
  { id: 'free_control', label: 'Free control (never paid)', clock: null },
  { id: 'S1', label: 'Paid control (normal renewal)', clock: 'A' },
  { id: 'S2', label: 'Card dies at renewal', clock: 'A' },
  { id: 'S3', label: 'Refunded, then canceled', clock: 'A' },
  { id: 'S4', label: 'Cancels at period end', clock: 'B' },
  { id: 'S5', label: 'Free trial, no card, expires', clock: 'B' },
]

export type Step = { name: string; at: number; actions: Action[] }

/** t0 = clock start, E = end of the first paid period (read from Stripe after the subscriptions exist). */
export function timeline(t0: number, E: number): Step[] {
  return [
    { name: 't0', at: t0, actions: [] },
    { name: 't0+1d', at: t0 + DAY, actions: ['kill_card_S2'] },
    { name: 't0+2d', at: t0 + 2 * DAY, actions: ['refund_cancel_S3'] },
    { name: 't0+3d', at: t0 + 3 * DAY + HOUR, actions: [] },
    { name: 't0+5d', at: t0 + 5 * DAY, actions: ['cancel_at_period_end_S4'] },
    { name: 'trial+1h', at: t0 + TRIAL_DAYS * DAY + HOUR, actions: [] }, // S5's trial just ended without a card
    { name: 'trial+26h', at: t0 + TRIAL_DAYS * DAY + T + 2 * HOUR, actions: [] }, // S5 dead for more than T
    { name: 'E-1h', at: E - HOUR, actions: [] },
    { name: 'E+1h', at: E + HOUR, actions: [] },
    { name: 'E+25h', at: E + T + HOUR, actions: [] },
    { name: 'E+4d', at: E + 4 * DAY, actions: [] },
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

/** The two controls must read as expected at every probe, otherwise the run proves nothing. */
export function controlsOk(rows: { id: ClientId; status: string; seen: Seen }[]): string | null {
  const free = rows.find((r) => r.id === 'free_control')
  const paid = rows.find((r) => r.id === 'S1')
  if (free && free.seen !== 'free') return `free control seen as ${free.seen}`
  if (paid && paid.status === 'active' && paid.seen !== 'paid') return `paid control (active) seen as ${paid.seen}`
  return null
}
