# Mannequin

**Crash-test customers for your Stripe subscriptions.**

Give Mannequin a public GitHub repo and a Stripe **test** key. An agent boots the real app in a CreateOS microVM, runs
fake customers through months of accelerated billing with Stripe test clocks, and reports which customers **keep paid
access without paying**, with a patch proven in a fresh VM. It never reads your access-control code: it logs in as each
customer and looks at what the app shows them.

**Live app:** https://01m561nw9fbywfz3b96c4x6pcm-3000.app.sb.createos.sh (itself running in a CreateOS Sandbox from the
Docker image `naesanon/mannequin:v1`). **Replay of a real run:** `/replay/sample`.

## The bug it finds

`shadcn-ui/taxonomy` only handles `checkout.session.completed` and `invoice.payment_succeeded`, and grants access with
`stripePriceId && stripeCurrentPeriodEnd + 1 day > now`. A customer who is refunded and canceled keeps PRO until the end
of the paid period. Real run:

| Customer | Stripe says | App shows | Verdict |
|---|---|---|---|
| free_control (never paid) | no subscription | Free | green |
| S1 normal renewal | active | PRO | green |
| S2 card dies at renewal | past_due, then canceled after retries | PRO, then Free | green |
| **S3 refunded, then canceled** | **canceled** | **"PRO / The PRO plan has unlimited posts."** from t0+3d to E+1h | **RED** |
| S4 cancels at period end | active, then canceled | PRO, then Free | green |
| S5 free trial, no card | trialing, then canceled at trial end | PRO, then Free | green |

The agent's patch (a `customer.subscription.deleted` handler using `updateMany` that clears `stripePriceId`) was applied
in a **fresh CreateOS fork**, the app rebuilt, and S3 replayed: **green**.

## How it works

1. **Snapshot.** The first run of a repo@commit installs and builds the app in a CreateOS `devbox:1` VM
   (`vm/prepare.sh`), then pauses it. Later runs of the same commit start from that snapshot.
2. **Fork per run.** Each run forks the snapshot into an isolated VM with a public ingress URL (for Stripe webhooks) and
   egress limited to `api.stripe.com`, `fonts.googleapis.com`, `fonts.gstatic.com`. The VM is destroyed at the end.
3. **The agent writes and runs its own code** (LLM with three tools: `sh`, `write_file`, `read_file`): `seed.js` puts
   customers in the app's database the way its checkout webhook would, `session.js` logs in as any of them. It tests
   its own scripts and fixes them when they fail.
4. **Simulated time.** The app runs under `libfaketime`, following the test clock. `vm/relay.js` verifies Stripe's real
   signature and re-signs each webhook at the app's time, so the app's own signature check accepts it.
5. **Two controls + differential probe.** A paying and a free customer calibrate which page tells paid from free. They
   are re-checked at every probe; if they read wrong, the run is inconclusive, never a bug.
6. **Scenarios on Stripe test clocks** (`lib/engine/timeline.ts`):

   | Id | Scenario |
   |---|---|
   | free_control / S1 | Free control (never paid) / paid control (normal renewal) |
   | S2 | Card dies at renewal (`pm_card_chargeCustomerFail`, Smart Retries, then canceled) |
   | S3 | Refunded, then canceled |
   | S4 | Cancels at period end |
   | S5 | 7-day free trial, no card, expires |
   | S6 | Trial with a card that declines |
   | S8 | Card dies, then fixed during retries (access must come back) |
   | P2 / S7 | Only if the app has 2+ plans: paid control on the expensive plan / downgrade to the cheaper plan |

7. **Deterministic verdict** (pure code, the LLM never touches it): red if the app grants access more than 24 h after
   Stripe says `canceled`, `unpaid` or `incomplete_expired`, or shows a more expensive plan than the one billed (24 h
   after a plan change). Cutting access while paying is orange, never red.
8. **Patch proven.** For the first leak, the agent writes a patch; a new fork applies it, rebuilds, and replays that
   customer with fresh Stripe objects up to the step that leaked.

The run page streams live (SSE), offers a PDF report (browser print), and "My runs" lists runs started from this
browser (localStorage only).

## Run it

**a) Live app:** open the link above, paste a public GitHub repo URL and a Stripe test key.

**b) Docker:**

```sh
docker run -p 3000:3000 -e CREATEOS_SANDBOX_API_KEY=... -e DEEPSEEK_API_KEY=... naesanon/mannequin:v1
```

**c) From source:**

```sh
# CreateOS key via Stripe Projects
stripe projects init
stripe projects link createos
stripe projects add createos/project      # provides CREATEOS_PROJECT_API_KEY

npm install
export CREATEOS_PROJECT_API_KEY=...        # or CREATEOS_SANDBOX_API_KEY, or ~/.createos_key
export CREATEOS_SANDBOX_BASE_URL=https://api-eu.sb.createos.sh   # default
export DEEPSEEK_API_KEY=...                # or ~/.deepseek_key; or LLM_API_KEY + LLM_BASE_URL + LLM_MODEL
npm run dev                                # UI on :3000, Stripe test key entered per run

# CLI (STRIPE_TEST_KEY or ~/.stripe_test_key)
npx tsx scripts/run.ts https://github.com/shadcn-ui/taxonomy

# Tests
for f in lib/engine/*.test.ts; do npx tsx "$f"; done
```

The LLM defaults to `deepseek-chat` at `https://api.deepseek.com` (any OpenAI-compatible API works).

## Tech used

| Component | What it does here |
|---|---|
| Stripe Projects | Provisioned the `createos/project` service whose key drives the sandboxes |
| CreateOS Sandbox SDK | `devbox:1` microVMs: pause (snapshot per repo@commit), fork per run, egress allowlist, public ingress for webhooks |
| Stripe API | Test clocks, test cards (incl. `pm_card_chargeCustomerFail`), refunds, webhook endpoint pinned to the app's API version, Smart Retries |
| DeepSeek (OpenAI-compatible API) | Agent with 3 tools (`sh`, `write_file`, `read_file`): seed, session, patch |
| libfaketime + relay | App runs at simulated time; webhooks re-signed at that time |
| Next.js 16 / React 19 | UI, run API, live events over SSE, replays |
| Docker | Self-contained image (Next standalone) for the live app |

## Project layout

```
app/                    Next.js UI: new run, run view (+ PDF report), replay, my runs
app/api/runs/           start a run (test key check), SSE events
app/api/replay/         replay recorded runs
lib/runs.ts             FIFO queue (one run at a time), event log, key redaction
lib/engine/run.ts       one run end to end: snapshot, fork, agent, scenarios, patch, proof
lib/engine/timeline.ts  fixed policy: timeline, expectations, verdict
lib/engine/probe.ts     differential probe and fingerprint
lib/engine/stripe.ts    test clocks, customers, life events, cleanup
lib/engine/agent.ts     agent loop (sh, write_file, read_file), redaction
lib/engine/vm.ts        CreateOS sandbox helpers, faketime, secrets
lib/engine/*.test.ts    tests
vm/relay.js             webhook re-signing relay (runs in the VM)
vm/prepare.sh           installs and builds the target app in the VM
vm/session.js           reference session forger for taxonomy (next-auth JWT)
scripts/run.ts          CLI; snapshot.ts prepares a snapshot; embed.mjs bundles runtime assets
Dockerfile
```

## Security

- Only `sk_test_` / `rk_test_` keys are accepted; live keys are refused.
- The key is not stored; secrets are redacted from agent tool output and from UI events.
- At the end of a run, test clocks (with their customers and subscriptions) and the webhook endpoint are deleted;
  prices and the product are archived (Stripe does not delete a used price).
- Every fork is destroyed, including on failure.

## Limits

- Public GitHub repos only.
- One run at a time per instance (FIFO queue).
- Go and static binaries are unsupported (libfaketime has no effect).
- Apps with no page that differs between paid and free users are reported inconclusive, never as a bug.
- Checkout itself is not tested: Mannequin tests everything after the first payment.

Built during the CreateOS x Stripe Projects hackathon, 17 October 2026.
