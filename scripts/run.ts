// CLI: npx tsx scripts/run.ts [repo] [--route /dashboard/billing]
// Stripe test key: $STRIPE_TEST_KEY or ~/.stripe_test_key
import { run, type RunEvent } from '../lib/engine/run'
import { secret } from '../lib/engine/vm'
import { appendFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const repo = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'https://github.com/shadcn-ui/taxonomy'
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
const route = opt('--route'), snapshot = opt('--snapshot')
const color = { green: '\x1b[32m', red: '\x1b[31;1m', orange: '\x1b[33m', grey: '\x1b[90m' }

mkdirSync('runs', { recursive: true })
const rec = `runs/${new Date().toISOString().replace(/[:.]/g, '-')}.events.jsonl` // replayable by the UI
const t0 = Date.now()
const print = (e: RunEvent) => {
  appendFileSync(rec, JSON.stringify({ t: Date.now() - t0, e }) + '\n')
  const ts = new Date().toISOString().slice(11, 19)
  if (e.type === 'phase') console.log(`\n${ts} == ${e.text}`)
  else if (e.type === 'log') console.log(`${ts}    ${e.text}`)
  else if (e.type === 'agent') console.log(`${ts}    [agent:${e.task}] ${e.event.kind === 'result' ? '  -> ' : ''}${e.event.text.split('\n').slice(0, 6).join('\n      ')}`)
  else if (e.type === 'detected') console.log(`${ts}    detected ${JSON.stringify(e.data)}`)
  else if (e.type === 'step') console.log(`${ts} -- ${e.name} (advance ${e.advanceMs} ms) ${e.actions.join('; ')} | webhooks: ${e.deliveries.map((d) => `${d.type}:${d.status}`).join(', ') || 'none'}`)
  else if (e.type === 'row') console.log(`${ts}    ${e.row.pass === 'patched' ? '[patched] ' : ''}${color[e.row.cell]}${e.row.id.padEnd(13)} stripe=${e.row.status.padEnd(9)} app=${e.row.seen.padEnd(7)} expect=${e.row.expect.padEnd(8)} ${e.row.cell.toUpperCase()}\x1b[0m ${e.row.cell === 'red' ? e.row.excerpt : ''}`)
  else if (e.type === 'invalid') console.log(`${ts} !! ${e.reason}`)
  else if (e.type === 'done') console.log(`\n${ts} VERDICT: ${e.summary.verdict} (${e.summary.red.length} red)\n${e.summary.patch ?? ''}\nPATCHED RE-RUN: ${e.summary.patched ? `${e.summary.patched.id} ${e.summary.patched.status} app=${e.summary.patched.seen} ${e.summary.patched.cell.toUpperCase()}` : 'n/a'}`)
}

run({ repo, route, snapshot, stripeKey: secret('STRIPE_TEST_KEY', '.stripe_test_key') }, print).then(
  () => process.exit(0), // keep-alive sockets in the SDKs would otherwise hold the process open
  (e) => { console.error(e); process.exit(1) },
)
