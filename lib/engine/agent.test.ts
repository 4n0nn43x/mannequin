import assert from 'node:assert/strict'
import { redact } from './agent'
const out = redact('STRIPE_API_KEY=sk_test_51AbC\nkey sk_live_9z here whsec_Q1w2\nNEXTAUTH_SECRET=abc\nDATABASE_URL=mysql://x')
assert.ok(!/sk_test_51|sk_live_9z|whsec_Q1|=abc/.test(out), out)
assert.match(out, /DATABASE_URL=mysql/)
console.log('redact ok')
