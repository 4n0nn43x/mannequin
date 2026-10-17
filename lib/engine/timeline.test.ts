import assert from 'node:assert/strict'
import { cell, controlsOk, expected, DAY, HOUR, T, timeline } from './timeline'

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
console.log('timeline ok')
