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
console.log('timeline ok')
