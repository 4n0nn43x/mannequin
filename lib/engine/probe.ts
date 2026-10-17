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

export type Fingerprint = { route: string; paid: string[]; free: string[] }

/** Lines present in every paid sample and no free sample, and the reverse. */
export function fingerprint(route: string, paidPages: string[], freePages: string[]): Fingerprint | null {
  const P = paidPages.map(lines), F = freePages.map(lines)
  const onlyIn = (A: Set<string>[], B: Set<string>[]) => [...A[0]].filter((l) => A.every((a) => a.has(l)) && B.every((b) => !b.has(l)))
  const paid = onlyIn(P, F), free = onlyIn(F, P)
  return paid.length || free.length ? { route, paid, free } : null
}

export function classify(html: string, fp: Fingerprint): Seen {
  const L = lines(html)
  const p = fp.paid.filter((l) => L.has(l)).length / Math.max(1, fp.paid.length)
  const f = fp.free.filter((l) => L.has(l)).length / Math.max(1, fp.free.length)
  if (p > f && p >= 0.5) return 'paid'
  if (f > p && f >= 0.5) return 'free'
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
  return [...fp.paid, ...fp.free].filter((l) => L.has(l)).slice(0, 2).join(' / ')
}
