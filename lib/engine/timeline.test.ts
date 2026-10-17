import assert from 'node:assert/strict'
import { cell, controlsOk, expected, planCell, DAY, HOUR, T, timeline } from './timeline'

const now = 1_800_000_000
assert.equal(expected('none', now, null), 'MUST_NOT')
assert.equal(expected('active', now, null), 'MUST')
assert.equal(expected('past_due', now, null), 'MAY')
assert.equal(expected('canceled', now, now - T + 60), 'MAY') // inside tolerance
assert.equal(expected('canceled', now, now - T - 60), 'MUST_NOT')
assert.equal(expected('unpaid', now, null), 'MAY') // dead time unknown: never a false red

assert.equal(cell('MUST_NOT', 'paid'), 'red')
assert.equal(cell('MUST', 'free'), 'orange')
assert.equal(cell('MAY', 'paid'), 'green')
assert.equal(cell('MUST_NOT', 'free'), 'green')
assert.equal(cell('MUST', 'unknown'), 'grey')

assert.equal(controlsOk([{ id: 'free_control', status: 'none', seen: 'free' }, { id: 'S1', status: 'active', seen: 'paid' }]), null)
assert.match(controlsOk([{ id: 'free_control', status: 'none', seen: 'paid' }])!, /free control/)

// S3 refunded+canceled at t0+2d must be judged dead (MUST_NOT) at the t0+3d+1h probe
const steps = timeline(now, now + 30 * DAY)
const s3probe = steps.find((s) => s.name === 't0+3d')!
assert.equal(expected('canceled', s3probe.at, now + 2 * DAY), 'MUST_NOT')
assert.ok(steps.every((s, i) => i === 0 || s.at > steps[i - 1].at), 'timeline strictly increasing')
assert.ok(steps.at(-1)!.at - now < 60 * DAY, 'within 2 billing intervals per advance and TLS window')
assert.equal(HOUR * 24, DAY)
// S5: trial ends at t0+7d; dead for more than T at the trial+26h probe, not yet at trial+1h
const t1 = steps.find((s) => s.name === 'trial+1h')!, t2 = steps.find((s) => s.name === 'trial+26h')!
assert.equal(expected('canceled', t1.at, now + 7 * DAY), 'MAY')
assert.equal(expected('canceled', t2.at, now + 7 * DAY), 'MUST_NOT')
assert.equal(expected('trialing', now, null), 'MUST')
assert.ok(t2.at < now + 30 * DAY - HOUR, 'trial probes come before the first renewal')
// plan change (S7): only judged after T, red only when the app shows a MORE expensive plan than the one billed
const ch = now - T - 60
assert.equal(planCell('green', now, ch, 0, 1), 'red') // still shows the expensive plan after downgrading
assert.equal(planCell('green', now, ch, 1, 0), 'orange') // shows a cheaper plan than the one paid
assert.equal(planCell('green', now, now - T + 60, 0, 1), 'green') // inside tolerance
assert.equal(planCell('green', now, null, 0, 1), 'green') // no plan change: never judged on plan
assert.equal(planCell('green', now, ch, 0, null), 'green') // plan unreadable: no plan verdict
assert.equal(planCell('red', now, ch, 0, 0), 'red') // status verdict wins
assert.match(controlsOk([{ id: 'free_control', status: 'none', seen: 'free' }, { id: 'P2', status: 'active', seen: 'free' }])!, /P2/)
// S7 changes plan at t0+2d: the t0+3d probe is more than T later
assert.ok(steps.find((s) => s.name === 't0+3d')!.at - steps.find((s) => s.actions.includes('change_plan_S7'))!.at > T)
// S8: card fixed during the retries (after the failed renewal, before Stripe gives up around E+8d)
const fixAt = steps.find((s) => s.actions.includes('fix_card_S8'))!.at, E = now + 30 * DAY
assert.ok(fixAt > E + HOUR && fixAt < E + 8 * DAY)
assert.equal(cell(expected('active', fixAt, null), 'free'), 'orange') // paid again but still cut: orange, never red
console.log('timeline ok')
