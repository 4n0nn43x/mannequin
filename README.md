# Mannequin

**Crash-test customers for your Stripe subscriptions.**

Give Mannequin a repo and a Stripe **test** key. An agent boots your real app in a CreateOS microVM, lives fake
customers through months of accelerated billing (Stripe test clocks), and tells you which customers **keep paid access
without paying**, with the fix proven.

Mannequin never reads your access-control code. It logs in as your customers and looks at what your app shows them.

**Live:** https://01m561nw9fbywfz3b96c4x6pcm-3000.app.sb.createos.sh (the app itself runs in a CreateOS Sandbox, from the Docker image `naesanon/mannequin`) ·
**Replay of a real run:** `/replay/sample`

## Result on shadcn-ui/taxonomy (real run)

| Customer | Stripe says | App shows | Verdict |
|---|---|---|---|
| free_control (never paid) | no subscription | Free | green |
| S1 normal renewal | active | PRO | green |
| S2 card dies at renewal | past_due, then canceled after 1 week of retries | PRO, then Free | green |
| **S3 refunded, then canceled** | **canceled** (10.00 USD refunded) | **"PRO / The PRO plan has unlimited posts."** from t0+3d to E+1h | **RED** |
| S4 cancels at period end | active, then canceled at period end | PRO, then Free | green |
| S5 7-day free trial, no card | trialing, then canceled when the trial ends | PRO during the trial, Free within 24 h | green |

The agent's patch (a `customer.subscription.deleted` handler using `updateMany`) was applied in a **fresh CreateOS
fork**, the app rebuilt, and S3 replayed: Free at t0+3d, **green**.

## The bug it finds

`shadcn-ui/taxonomy` (19k stars, 2.7k forks) only handles `checkout.session.completed` and `invoice.payment_succeeded`,
and decides access with `stripePriceId && stripeCurrentPeriodEnd + 1 day > now`. A customer who is **refunded and
canceled** keeps PRO until the end of the paid period: about a month free, every refund. The app answers 200 to every
webhook, so a tool that only checks webhook responses sees nothing.

## How a run works

1. **Snapshot (CreateOS pause).** The first run of a repo@commit installs and builds the app in a `devbox:1` VM, then the
   VM is **paused**. Later runs of the same commit start from it, already built.
2. **Fork per run (CreateOS fork).** Each run is a fresh, isolated VM forked from the snapshot, with a public HTTPS URL
   (ingress) for Stripe webhooks and egress limited to Stripe (plus Google Fonts for the rebuild), destroyed at the end.
3. **The agent writes and runs its own code** (LLM with three tools: `sh`, `write_file`, `read_file`):
   `seed.js` puts customers in the app's database exactly as its checkout webhook would, `session.js` logs in as any of
   them with the app's own auth library. If the probe cannot read the app, the agent debugs and fixes its session code.
4. **The whole app lives at Stripe's simulated time** (`libfaketime`). A relay verifies Stripe's real signature and
   re-signs each webhook at the app's time, so the app's own `constructEvent` accepts it.
5. **Two controls** (a paying and a free customer) calibrate a differential probe: which page tells them apart. They are
   re-checked at every probe; if they read wrong, there is no verdict.
6. **Stripe test clocks** play the scenarios: normal renewal, card dies at renewal (retries, then canceled), refunded
   then canceled, cancel at period end, free trial without a card that expires.
7. **Deterministic verdict**: access granted where Stripe itself says the subscription is dead (`canceled`, `unpaid`,
   `incomplete_expired`) for more than 24 hours is red. Cutting access early is never red. The LLM never touches the
   policy or the verdict.
8. **Patch**: the agent writes the smallest fix for the leak.

## Run it

With Docker (the image the live demo runs):

```sh
docker run -p 3000:3000 -e CREATEOS_SANDBOX_API_KEY=... -e CREATEOS_SANDBOX_BASE_URL=https://api-eu.sb.createos.sh \
  -e DEEPSEEK_API_KEY=... naesanon/mannequin:v1
```

From source:

```sh
npm install
# keys: STRIPE_TEST_KEY, CREATEOS_PROJECT_API_KEY (provisioned by Stripe Projects, in .env) or CREATEOS_SANDBOX_API_KEY, DEEPSEEK_API_KEY (or ~/.stripe_test_key, ~/.createos_key, ~/.deepseek_key)
export CREATEOS_SANDBOX_BASE_URL=https://api-eu.sb.createos.sh
npx tsx scripts/run.ts https://github.com/shadcn-ui/taxonomy
```

Only `sk_test_` / `rk_test_` keys are accepted. At the end of a run, the test clocks (with their customers and subscriptions) and the webhook
endpoint are deleted; the price and product are archived (Stripe does not delete a price that was used).

## Stack

- **Stripe Projects**: provisions the CreateOS project and its credentials.
- **CreateOS Sandbox**: `devbox:1` microVMs, pause (snapshot per commit), fork (one VM per run), ingress (public
  webhook URL), egress control.
- **Stripe**: test clocks, test cards (`pm_card_chargeCustomerFail`), refunds, webhook endpoints pinned to the app's API
  version, Smart Retries.
- **LLM**: DeepSeek (OpenAI-compatible API) for the agent.
- `libfaketime` for simulated time, MariaDB for the target app's database.

## Layout

```
lib/engine/timeline.ts   fixed policy: timeline, expectations, one-way verdict (+ timeline.test.ts)
lib/engine/probe.ts      differential probe and fingerprint (+ probe.test.ts)
lib/engine/stripe.ts     test clocks, customers, life events, cleanup
lib/engine/agent.ts      the agent loop (sh, write_file, read_file)
lib/engine/vm.ts         CreateOS sandbox helpers
lib/engine/run.ts        one run, end to end, in a fixed order
vm/relay.js              webhook re-signing relay (runs in the VM)
vm/prepare.sh            installs and builds the target app in the VM
scripts/run.ts           CLI
```

## Limits (said up front, never a fake result)

Go and static binaries (libfaketime has no effect), apps with no page that differs between paid and free users, and
OAuth-only auth with no way to mint a session are reported as unsupported or inconclusive. Checkout itself is not
tested: Mannequin tests everything after the first payment.

Built during the CreateOS x Stripe Projects hackathon, 17 October 2026.
