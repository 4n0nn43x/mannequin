// One Mannequin run, end to end. The ORDER is fixed here, not left to the LLM.
import type { Sandbox } from '@nodeops-createos/sandbox'
import { readFileSync } from 'node:fs'
import { ASSETS } from './assets.gen'
import { agentTask, type AgentEvent } from './agent'
import { classify, evidence, fetchAs, fingerprint, fingerprintPlans, planOf, type Fingerprint } from './probe'
import * as S from './stripe'
import { CLIENTS, cell, controlsOk, expected, planCell, timeline, type Cell, type ClientId, type Seen } from './timeline'
import { createos, daemon, findSandbox, must, put, setOffset, SHAPE, sh, snapshotName, waitHttp } from './vm'

export type RunInput = { repo: string; stripeKey: string; route?: string; webhookPath?: string; apiVersion?: string; snapshot?: string }
export type Pass = 'main' | 'patched'
/** plan / stripePlan: only for apps with several plans (the plan the page shows, the plan Stripe bills). */
export type Row = { pass: Pass; step: string; at: number; id: ClientId; status: string; seen: Seen; expect: string; cell: Cell; excerpt: string; plan?: string; stripePlan?: string }
export type RunEvent =
  | { type: 'phase'; text: string }
  | { type: 'log'; text: string }
  | { type: 'agent'; task: string; event: AgentEvent }
  | { type: 'detected'; data: Record<string, string> }
  | { type: 'step'; pass: Pass; name: string; at: number; advanceMs: number; deliveries: { type: string; status: number }[]; actions: string[] }
  | { type: 'row'; row: Row }
  | { type: 'invalid'; reason: string }
  | { type: 'done'; summary: Summary }
export type Summary = { verdict: 'bugs' | 'clean' | 'inconclusive'; red: Row[]; rows: Row[]; fingerprint?: Fingerprint; patch?: string; patched?: Row }
type Detected = Awaited<ReturnType<typeof detect>>

// files shipped into the VM, embedded at build time (npm run embed) so the server never depends on its working directory
const local = (p: string) => ASSETS[p] ?? readFileSync(p, 'utf8')

// The fork may only reach Stripe (and Google Fonts, which next build needs for the patched rebuild). CreateOS egress control.
const EGRESS = ['api.stripe.com:443', 'fonts.googleapis.com:443', 'fonts.gstatic.com:443']

export async function run(input: RunInput, emit: (e: RunEvent) => void): Promise<Summary> {
  const stripe = S.stripeFor(input.stripeKey)
  const phase = (text: string) => emit({ type: 'phase', text })
  const agentLog = (task: string) => (event: AgentEvent) => emit({ type: 'agent', task, event })

  emit({ type: 'log', text: `repo ${input.repo}` }) // the report reads it
  phase('Preparing the app in a CreateOS snapshot')
  const snap = await ensureSnapshot(input.repo, input.snapshot, emit)
  const fork = async () => {
    phase('Forking the snapshot into a fresh, isolated VM (egress: Stripe and Google Fonts only)')
    const vm = await snap.fork({ ingress_enabled: true, egress: EGRESS })
    try {
      await vm.waitUntilRunning({ timeoutMs: 300_000 }) // usually ~60 s, sometimes much more
      await must(vm, 'mkdir -p /run/m && echo +0 > /run/m/offset && : > /run/m/deliveries.log && bash /root/mq/start-db.sh', 120_000)
      return vm
    } catch (e) {
      await vm.destroy().catch(() => undefined) // never leave an orphan VM holding a slot
      throw e
    }
  }

  let vm: Sandbox | undefined = await fork()
  let tools: Record<string, string>
  let summary: Summary
  try {
    const det = await detect(vm, input)
    emit({ type: 'detected', data: { ...det, plans: det.plans.map((p) => `${p.tier} (${p.env})`).join(', '), interval: det.interval } })
    const main = await scenario(vm, stripe, input, det, 'main', emit, agentLog)
    summary = main.summary
    if (!summary.red.length) return finish(emit, summary)

    phase('Agent writes a patch for the first leak')
    summary.patch = await proposePatch(vm, summary.red[0], det, agentLog)
    tools = Object.fromEntries(await Promise.all(['seed.js', 'session.js', 'patch.diff'].map(async (f) => [f, (await sh(vm!, `cat /root/mq/${f}`)).out] as const)))
    await vm.destroy().catch(() => undefined) // frees the slot for the proof fork
    vm = undefined
  } catch (e) {
    if (vm) await vm.destroy().catch(() => undefined)
    throw e
  }

  // Proof: same snapshot, new fork, patch applied, the leaking customer replayed with fresh Stripe objects.
  try {
    vm = await fork()
    for (const [f, c] of Object.entries(tools)) await put(vm, `/root/mq/${f}`, c + '\n')
    phase('Applying the patch and rebuilding in the new fork')
    await must(vm, 'cd /root/app && git apply --whitespace=nowarn /root/mq/patch.diff && git diff --stat', 60_000)
    await must(vm, 'cd /root/app && pnpm next build > /run/m/build.log 2>&1 || (tail -30 /run/m/build.log; exit 1)', 0)
    const det = await detect(vm, input)
    const proof = await scenario(vm, stripe, input, det, 'patched', emit, agentLog, summary.red[0].step) // replay up to the first leak, whichever customer it is
    summary.patched = proof.summary.rows.filter((r) => r.id === summary.red[0].id).at(-1)
  } catch (e) {
    emit({ type: 'log', text: `patched re-run failed: ${(e as Error).message.slice(0, 300)}` })
  } finally {
    if (vm) await vm.destroy().catch(() => undefined)
  }
  return finish(emit, summary)
}

/** Stripe objects, seed, webhook relay, app, session, calibration, then the timeline (optionally stopped early). */
async function scenario(vm: Sandbox, stripe: ReturnType<typeof S.stripeFor>, input: RunInput, det: Detected, pass: Pass,
  emit: (e: RunEvent) => void, agentLog: (t: string) => (e: AgentEvent) => void, stopAfter?: string) {
  const phase = (text: string) => emit({ type: 'phase', text: pass === 'patched' ? `[patched] ${text}` : text })
  const created: Parameters<typeof S.cleanup>[1] = {}
  try {
    phase('Creating test clocks, customers and subscriptions in Stripe')
    const t0 = Math.floor(Date.now() / 1000) // never backdate: the app's TLS calls to Stripe follow its clock
    const st = await S.setup(stripe, Date.now().toString(36), t0, det.plans, det.interval)
    Object.assign(created, { clocks: st.clocks, prices: Object.values(st.prices), product: st.product.id })

    const haveSeed = (await sh(vm, 'test -s /root/mq/seed.js')).code === 0
    if (!haveSeed) {
      phase('Agent writes seed.js: put customers in the app database like its checkout webhook would')
      await agentUntil(vm, SEED_TASK, '/root/mq/seed.js', agentLog('seed'))
    }
    const seed = st.subs.map((s) => ({ email: s.email, name: 'Mannequin Customer', // same name for all: the probe must read the plan, not the person
      stripeCustomerId: s.customer ?? null, stripeSubscriptionId: s.sub ?? null,
      stripePriceId: s.price ?? null, stripeCurrentPeriodEnd: s.periodEnd ?? null })) // trial: period end = trial end, as checkout would store it
    await put(vm, '/root/mq/seed.json', JSON.stringify(seed))
    await must(vm, 'cd /root/app && node /root/mq/seed.js /root/mq/seed.json')

    phase('Webhook endpoint -> relay (real time) -> app (simulated time)')
    await vm.setIngress(true)
    const ep = await S.webhookEndpoint(stripe, vm.previewUrl(8787) + det.webhookPath, det.apiVersion)
    created.endpoint = ep.id
    // every plan env var the app reads gets its test price (names come from a [A-Z0-9_] grep: safe in sed and the heredoc)
    const planEnv = Object.entries(st.prices)
    const drop = ['STRIPE_API_KEY', 'STRIPE_WEBHOOK_SECRET', ...planEnv.map(([k]) => k)].map((k) => `/^${k}=/d`).join(';')
    await must(vm, `cd /root/app && sed -i '${drop}' .env && cat >> .env <<'EOF'
STRIPE_API_KEY=${input.stripeKey}
STRIPE_WEBHOOK_SECRET=${ep.secret}
${planEnv.map(([k, v]) => `${k}=${v}`).join('\n')}
EOF`)
    await put(vm, '/root/mq/relay.js', local('vm/relay.js'))
    await daemon(vm, 'relay', `env WHSEC=${ep.secret} node /root/mq/relay.js`)
    await daemon(vm, 'app', 'bash /root/mq/start-app.sh')
    await waitHttp(vm, 'http://127.0.0.1:3000/')
    await waitHttp(vm, 'http://127.0.0.1:8787/')

    if ((await sh(vm, 'test -s /root/mq/session.js')).code !== 0) {
      phase("Agent writes session.js: log in as any customer with the app's own auth library")
      await agentUntil(vm, SESSION_TASK, '/root/mq/session.js', agentLog('session'))
    }

    phase('Calibration: can the probe tell the paid control from the free control?')
    const by = (id: ClientId) => st.subs.find((s) => s.id === id)!
    // two DIFFERENT paying customers per plan: anything personal (name, email, ids) cannot end up in the fingerprint
    const byPlan: Record<string, string[]> = { [st.tiers[0]]: [by('S1').email, by('S4').email] }
    if (st.multi) byPlan[st.tiers.at(-1)!] = [by('P2').email, by('S7').email]
    const fp = await calibrate(vm, byPlan, by('free_control').email, det.route, emit, agentLog)
    if (!fp) return { summary: { verdict: 'inconclusive', red: [], rows: [] } as Summary }

    const rows: Row[] = []
    const deadSince: Partial<Record<ClientId, number>> = {}
    const changedAt: Partial<Record<ClientId, number>> = {} // when Stripe switched a customer's plan
    const clients = CLIENTS.filter((c) => !c.multi || st.multi)
    const rank = (tier: string | null) => (tier && st.tiers.includes(tier) ? st.tiers.indexOf(tier) : null)
    let seenDeliveries = 0
    for (const step of timeline(t0, st.E)) {
      await setOffset(vm, step.at - Math.floor(Date.now() / 1000)) // offset BEFORE the advance
      const advanceMs = step.at === t0 ? 0 : await S.advance(stripe, st.clocks, step.at)
      const actions = []
      for (const a of step.actions) {
        if (a === 'change_plan_S7' && !st.multi) continue
        actions.push(await S.act(stripe, a, st.subs))
        if (a === 'change_plan_S7') changedAt.S7 = step.at
      }
      const all = await settle(vm, seenDeliveries)
      emit({ type: 'step', pass, name: step.name, at: step.at, advanceMs, deliveries: all.slice(seenDeliveries), actions })
      seenDeliveries = all.length

      const stepRows: Row[] = []
      for (const c of clients) {
        const sub = by(c.id)
        const { status, deadAt, price } = await S.status(stripe, sub)
        if (['canceled', 'unpaid', 'incomplete_expired'].includes(status)) deadSince[c.id] ??= deadAt ?? step.at
        const page = await fetchAs(vm, sub.email, fp.route)
        const seen = classify(page.html, fp)
        const exp = expected(status, step.at, deadSince[c.id] ?? null)
        const plan = seen === 'paid' ? planOf(page.html, fp) : null
        const stripePlan = price ? st.tierOfPrice[price] ?? null : null
        const verdict = planCell(cell(exp, seen), step.at, changedAt[c.id] ?? null, rank(stripePlan), rank(plan))
        const row: Row = { pass, step: step.name, at: step.at, id: c.id, status, seen, expect: exp, cell: verdict, excerpt: evidence(page.html, fp),
          ...(st.multi ? { plan: plan ?? undefined, stripePlan: stripePlan ?? undefined } : {}) }
        stepRows.push(row); rows.push(row); emit({ type: 'row', row })
      }
      const bad = controlsOk(stepRows)
      if (bad) { emit({ type: 'invalid', reason: `${step.name}: ${bad}` }); return { summary: { verdict: 'inconclusive', red: [], rows, fingerprint: fp } as Summary } }
      if (step.name === stopAfter) break
    }
    const red = rows.filter((r) => r.cell === 'red')
    return { summary: { verdict: red.length ? 'bugs' : 'clean', red, rows, fingerprint: fp } as Summary }
  } finally {
    phase('Cleanup: Stripe test objects')
    await S.cleanup(stripe, created)
  }
}

/** Run an agent task; if the file it must produce is missing, give it one more try with that feedback. */
async function agentUntil(vm: Sandbox, task: string, file: string, log: (e: AgentEvent) => void) {
  let last = ''
  for (let i = 0; i < 2; i++) {
    last = await agentTask(vm, i ? `${task}\n\nYour previous attempt ended without producing ${file} (it said: ${last.slice(0, 300)}). Write it now with write_file, then test it.` : task, log)
    if ((await sh(vm, `test -s ${file}`)).code === 0) return
  }
  throw new Error(`the agent did not produce ${file}`)
}

function finish(emit: (e: RunEvent) => void, s: Summary) { emit({ type: 'done', summary: s }); return s }

/** Wait until the relay has been quiet for a few seconds (webhook delivery order vs clock 'ready' is not guaranteed). */
async function settle(vm: Sandbox, before: number) {
  // ponytail: quiet-period heuristic; upgrade to waiting for the step's expected event types if deliveries lag
  let last = -1, quiet = 0
  for (let i = 0; i < 30 && quiet < 3; i++) {
    const n = Number((await sh(vm, 'wc -l < /run/m/deliveries.log')).out) || 0
    quiet = n === last && n >= before ? quiet + 1 : 0
    last = n
    await new Promise((ok) => setTimeout(ok, 2000))
  }
  const log = (await sh(vm, 'cat /run/m/deliveries.log')).out
  return log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; status: number })
}

/** Paused VM with the app installed and built (CreateOS pause = snapshot). One per repo@commit, reused by every run. */
export async function ensureSnapshot(repo: string, override: string | undefined, emit: (e: RunEvent) => void) {
  const commit = await headCommit(repo)
  const name = override ?? snapshotName(repo, commit)
  const existing = await findSandbox(name)
  if (existing && String(existing.status) === 'paused') { emit({ type: 'log', text: `snapshot ${name} found: install and build already done` }); return existing }
  if (existing) await existing.destroy() // half-prepared leftover

  emit({ type: 'log', text: `no snapshot for ${commit.slice(0, 7)}: installing and building in ${name} (about 2 min)` })
  const vm = await createos().createSandbox({ shape: SHAPE, rootfs: 'devbox:1', name, ingress_enabled: true }, { wait: true })
  await must(vm, 'mkdir -p /root/mq /run/m')
  await put(vm, '/root/mq/prepare.sh', local('vm/prepare.sh'))
  await must(vm, `REPO=${JSON.stringify(repo)} REF=${commit} bash /root/mq/prepare.sh > /root/mq/prepare.log 2>&1 || (tail -40 /root/mq/prepare.log; exit 1)`, 0)
  await must(vm, 'bash /root/mq/stop.sh', 120_000) // processes survive a pause: stop them so forks start clean
  await vm.pause(); await vm.waitUntilPaused({ timeoutMs: 180_000 })
  return vm
}

/** HEAD commit via the GitHub API (no git binary needed where the orchestrator is deployed). */
async function headCommit(repo: string): Promise<string> {
  const m = repo.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(\.git)?\/?$/)
  if (!m) throw new Error('only https://github.com/<owner>/<repo> URLs are supported')
  const r = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/HEAD`, { headers: { accept: 'application/vnd.github.sha' } })
  if (!r.ok) throw new Error(`GitHub: cannot read ${m[1]}/${m[2]} (${r.status}); private repos need a read-only token`)
  return (await r.text()).trim()
}

async function detect(vm: Sandbox, input: RunInput) {
  const grep = async (cmd: string) => (await sh(vm, `cd /root/app && ${cmd}`)).out.split('\n')[0]?.trim() ?? ''
  const handler = await grep(`grep -rl --include=*.ts --include=*.js 'constructEvent' app pages src 2>/dev/null | head -1`)
  const webhookPath = input.webhookPath ?? '/' + handler.replace(/^(src\/)?(app|pages)\//, '').replace(/\/route\.(t|j)s$|\.(t|j)s$/, '').replace(/\([^)]*\)\//g, '')
  const apiVersion = input.apiVersion ?? (await grep(`grep -rhoE "apiVersion: *['\\"][0-9]{4}-[0-9]{2}-[0-9]{2}" lib src 2>/dev/null | head -1 | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}'`) || '2022-11-15')
  const auth = await grep(`node -e "const p=require('./package.json');const d={...p.dependencies};console.log(['next-auth','@clerk/nextjs','@supabase/supabase-js','better-auth','lucia'].filter(k=>d[k]).map(k=>k+'@'+d[k]).join(', ')||'unknown')"`)
  const route = input.route ?? ''
  // the app's plans: env vars holding Stripe price ids, from its env template and its code
  const names = (await sh(vm, `cd /root/app && { cat .env.example .env.local.example .env.sample 2>/dev/null; grep -rhoE --include=*.ts --include=*.tsx --include=*.js --include=*.mjs 'STRIPE_[A-Z0-9_]+' config lib src app pages env.mjs 2>/dev/null; } | grep -oE 'STRIPE_[A-Z0-9_]*(PRICE|PLAN)[A-Z0-9_]*' | sort -u`)).out
  const plans = S.plansFrom(names.split('\n').filter(Boolean))
  return { handler, webhookPath, apiVersion, auth, route, plans, interval: S.intervalOf(plans[0].env) }
}

/** byPlan: plan -> two paying customers on it. One plan: the paid/free fingerprint; several: plus one per plan. */
async function calibrate(vm: Sandbox, byPlan: Record<string, string[]>, freeEmail: string, route: string, emit: (e: RunEvent) => void, agentLog: (t: string) => (e: AgentEvent) => void) {
  const candidates = route ? [route] : await candidateRoutes(vm)
  const paid = Object.values(byPlan).flat()
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const r of candidates) {
      const plansPages: Record<string, { status: string; html: string }[]> = {}
      for (const [plan, emails] of Object.entries(byPlan)) plansPages[plan] = [await fetchAs(vm, emails[0], r), await fetchAs(vm, emails[1], r)]
      const free = [await fetchAs(vm, freeEmail, r), await fetchAs(vm, freeEmail, r)]
      const pages = [...Object.values(plansPages).flat(), ...free]
      emit({ type: 'log', text: `calibration ${r}: HTTP ${pages.map((p) => p.status).join(' ')}` })
      const html = (ps: { html: string }[]) => ps.map((p) => p.html)
      const keys = Object.keys(plansPages)
      const fp = !pages.every((p) => p.status === '200') ? null
        : keys.length === 1 ? fingerprint(r, html(plansPages[keys[0]]), html(free))
        : fingerprintPlans(r, Object.fromEntries(keys.map((k) => [k, html(plansPages[k])])), html(free))
      if (fp) {
        emit({ type: 'log', text: `fingerprint on ${r}: paid "${fp.paid.slice(0, 2).join(' | ')}" vs free "${fp.free.slice(0, 2).join(' | ')}"` })
        if (keys.length > 1) emit({ type: 'log', text: fp.plans ? `plans on ${r}: ${Object.entries(fp.plans).map(([k, l]) => `${k} "${l[0]}"`).join(' vs ')}` : `plans on ${r}: the page shows no difference between ${keys.join(' and ')}, plan changes are not judged` })
        return fp
      }
    }
    if (attempt === 0) {
      // the agent fixes its own session script (wrong cookie, redirect, CSRF...) and we try again
      await agentTask(vm, `${SESSION_TASK}\n\nThe calibration just failed: requests with your cookie on ${candidates.join(', ')} did not return HTTP 200 pages that differ between the paid users ${paid.join(', ')} and the free user ${freeEmail} (both are seeded now). Debug with curl -i, fix /root/mq/session.js, and verify on ${candidates[0]}.`, agentLog('session-fix'))
    }
  }
  emit({ type: 'invalid', reason: 'no route tells a paying customer from a free one: inconclusive, never a bug' })
  return null
}

async function candidateRoutes(vm: Sandbox) {
  const out = (await sh(vm, `cd /root/app && find app pages src/app -name 'page.*' -o -name '*.tsx' -path '*pages*' 2>/dev/null | grep -iE 'billing|plan|subscription|account|settings|pricing' | head -8`)).out
  const routes = out.split('\n').filter(Boolean).map((f) => '/' + f.replace(/^(src\/)?(app|pages)\//, '').replace(/\([^)]*\)\//g, '').replace(/\/?page\.\w+$|\.\w+$/, '').replace(/\/index$/, ''))
  const rank = (r: string) => (/billing|plan|subscription/i.test(r) ? 0 : 1)
  return [...new Set(routes.filter((r) => !r.includes('[') && !r.includes('api')))].sort((a, b) => rank(a) - rank(b))
}

async function proposePatch(vm: Sandbox, red: Row, det: Detected, agentLog: (t: string) => (e: AgentEvent) => void) {
  const handler = (await sh(vm, `cat /root/app/${det.handler}`)).out
  const access = (await sh(vm, `cd /root/app && grep -rln --include=*.ts -E 'isPro|stripeCurrentPeriodEnd' lib app 2>/dev/null | grep -v webhooks | head -2 | xargs -r head -c 2500`)).out
  const planLeak = !!red.stripePlan && !!red.plan && red.stripePlan !== red.plan
  const fact = planLeak
    ? `customer ${red.id} switched to the cheaper plan ${red.stripePlan} in Stripe more than 24 hours ago, but the app still shows them the ${red.plan} plan ("${red.excerpt}").`
    : `customer ${red.id} is "${red.status}" in Stripe (dead for more than 24 hours) but the app still shows them the paid plan ("${red.excerpt}").`
  const fix = planLeak
    ? 'handle "customer.subscription.updated" so the stored price and period end always follow the subscription (items.data[0].price.id and its current_period_end)'
    : 'handle "customer.subscription.deleted" so the customer loses paid access as soon as Stripe sends it (e.g. clear the stored price and set the period end to the subscription\'s ended_at)'
  await agentTask(vm, `A billing leak was PROVEN by running the app (do not investigate it again, do not call Stripe):
${fact}

The webhook handler /root/app/${det.handler}:
\`\`\`ts
${handler}
\`\`\`
Code that decides paid access:
\`\`\`ts
${access}
\`\`\`
Task, in at most 3 tool calls:
1. write_file /root/app/${det.handler} with the full fixed file: ${fix}, using updateMany so an unknown subscription does not throw. Keep everything else identical.
2. sh: cd /root/app && git diff > /root/mq/patch.diff && cat /root/mq/patch.diff
Then answer DONE.`, agentLog('patch'), 6)
  return (await sh(vm, 'cat /root/mq/patch.diff')).out
}

const SEED_TASK = `Write /root/mq/seed.js (CommonJS, run as: cd /root/app && node /root/mq/seed.js /root/mq/seed.json).
The JSON file is an array of {email, name, stripeCustomerId, stripeSubscriptionId, stripePriceId, stripeCurrentPeriodEnd} (period end in unix SECONDS, nulls for the free user).
For each entry, upsert the user in the app's database EXACTLY as the app's own Stripe checkout webhook handler would leave them after a successful subscription checkout. First read prisma/schema.prisma (or the app's ORM schema) and the Stripe webhook handler to learn the fields. Use the app's ORM client from /root/app/node_modules and the DATABASE_URL in /root/app/.env (load it yourself, e.g. with dotenv from node_modules or by parsing the file).
Then test it: write a sample /root/mq/seed.sample.json with one paid and one free user, run it, verify the rows with a query, then delete those sample users.`

const SESSION_TASK = `Write /root/mq/session.js (CommonJS, run as: cd /root/app && node /root/mq/session.js <email>). It must print ONE line: a Cookie header value (name=value; ...) that authenticates as the existing user with that email, produced with the app's OWN auth library and secrets from /root/app/.env (for NextAuth with the JWT strategy: encode() from next-auth/jwt with NEXTAUTH_SECRET, cookie next-auth.session-token on plain http). Read the app's auth config first.
Test it: the app is served at http://127.0.0.1:3000 (start it with: bash /root/mq/start-app.sh > /run/m/app.log 2>&1 & and wait for it if it is not running). Create a throwaway user with the seed script (cd /root/app && node /root/mq/seed.js with a one-entry JSON), then curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $(node /root/mq/session.js <email>)" http://127.0.0.1:3000/dashboard must give 200 (not a redirect to a login page). Delete the throwaway user at the end.`
