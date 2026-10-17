// Differential probe: log in as a customer (agent-written session script, run at simulated time), fetch the
// calibrated route, and classify the page as paid or free by comparing it with the two controls' fingerprints.
import type { Sandbox } from '@nodeops-createos/sandbox'
import { FAKETIME, sh } from './vm'
import type { Seen } from './timeline'

const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi

/** Visible text lines, with the parts that change on their own (dates, numbers, tokens) masked. */
export function lines(html: string): Set<string> {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
  const out = new Set<string>()
  for (const l of text.split('\n')) {
    const n = l.replace(/[\w.+-]+@[\w.-]+/g, 'EMAIL').replace(MONTHS, 'M').replace(/[0-9a-f]{16,}/gi, 'X').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
    if (n.length > 1 && n.length < 300) out.add(n)
  }
  return out
}

/** plans: per plan, the lines that tell it apart from the app's other plans (only when every plan is distinguishable). */
export type Fingerprint = { route: string; paid: string[]; free: string[]; plans?: Record<string, string[]> }

const onlyIn = (A: Set<string>[], B: Set<string>[]) => [...A[0]].filter((l) => A.every((a) => a.has(l)) && B.every((b) => !b.has(l)))

/** Lines present in every paid sample and no free sample, and the reverse. */
export function fingerprint(route: string, paidPages: string[], freePages: string[]): Fingerprint | null {
  const P = paidPages.map(lines), F = freePages.map(lines)
  const paid = onlyIn(P, F), free = onlyIn(F, P)
  return paid.length || free.length ? { route, paid, free } : null
}

/** Several plans: paid vs free as above over all plans, plus one fingerprint per plan against the other plans.
 * Plans the page cannot tell apart (e.g. monthly and yearly of the same tier) give no plan fingerprint at all. */
export function fingerprintPlans(route: string, plansPages: Record<string, string[]>, freePages: string[]): Fingerprint | null {
  const byPlan = Object.entries(plansPages).map(([k, pages]) => [k, pages.map(lines)] as const)
  const P = byPlan.flatMap(([, s]) => s), F = freePages.map(lines)
  // a plan line must also be absent from the free page: otherwise a canceled customer's page could match a plan (false red)
  const plans = Object.fromEntries(byPlan.map(([k, s]) => [k, onlyIn(s, [...byPlan.filter(([o]) => o !== k).flatMap(([, x]) => x), ...F])]))
  const paid = onlyIn(P, F), free = onlyIn(F, P), distinct = Object.values(plans).every((l) => l.length)
  if (!paid.length && !free.length && !distinct) return null
  return { route, paid, free, ...(distinct ? { plans } : {}) }
}

const score = (L: Set<string>, want: string[]) => want.filter((l) => L.has(l)).length / Math.max(1, want.length)

/** The plan the page shows, or null when no plan fingerprint matches clearly. */
export function planOf(html: string, fp: Fingerprint): string | null {
  if (!fp.plans) return null
  const L = lines(html)
  const s = Object.entries(fp.plans).map(([k, want]) => [k, score(L, want)] as const).sort((a, b) => b[1] - a[1])
  return s[0][1] >= 0.5 && (s.length < 2 || s[0][1] > s[1][1]) ? s[0][0] : null
}

export function classify(html: string, fp: Fingerprint): Seen {
  const L = lines(html)
  const p = score(L, fp.paid)
  const f = score(L, fp.free)
  if (p > f && p >= 0.5) return 'paid'
  if (f > p && f >= 0.5) return 'free'
  if (f < 0.5 && planOf(html, fp)) return 'paid' // plans share no line: a recognized plan is paid access
  return 'unknown'
}

/** One HTTP request as the customer, inside the VM. Session is re-made each time (time jumps expire tokens). */
export async function fetchAs(vm: Sandbox, email: string, route: string): Promise<{ status: string; html: string }> {
  const r = await sh(vm, `cd /root/app && C=$(${FAKETIME} node /root/mq/session.js ${JSON.stringify(email)} | tail -1) && ` +
    `curl -s -w '\\n@@%{http_code}' -H "Cookie: $C" ${JSON.stringify('http://127.0.0.1:3000' + route)}`, 60_000)
  const i = r.out.lastIndexOf('@@')
  return { status: i >= 0 ? r.out.slice(i + 2).trim() : String(r.code), html: i >= 0 ? r.out.slice(0, i) : r.out }
}

/** Short excerpt of the decisive line(s), for the report. */
export function evidence(html: string, fp: Fingerprint): string {
  const L = lines(html)
  return [...fp.paid, ...fp.free, ...Object.values(fp.plans ?? {}).flat()].filter((l) => L.has(l)).slice(0, 2).join(' / ')
}
