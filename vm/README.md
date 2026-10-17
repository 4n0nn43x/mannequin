# vm/: target app inside a CreateOS microVM (taxonomy)

Verified 2026-10-17 on `devbox:1`, shape `s-2vcpu-4gb`, region eu, taxonomy commit `298a885`.

## Files

- `prepare.sh`: runs INSIDE a fresh devbox:1 as root. Idempotent (re-run on a prepared VM: 7 s).
  `REPO=<git url> bash /root/mq/prepare.sh` (REPO defaults to shadcn-ui/taxonomy, optional `REF=<commit>`).
  Installs mariadb-server + faketime (apt), Node 18 in `/opt/n` (via `n`), pnpm 8, clones into `/root/app`,
  writes `/root/app/.env` (only if absent), `pnpm install --frozen-lockfile`, `prisma db push`,
  `pnpm contentlayer build`, `pnpm next build` (skipped if `.next/BUILD_ID` exists, `FORCE_BUILD=1` to force).
  Exits non-zero on failure. Writes the helpers below. Does NOT write seed.js / session.js.
- `/root/mq/start-db.sh`: starts MariaDB (mysqld_safe, setsid nohup, LD_PRELOAD unset, real time),
  idempotent, waits for `mysqladmin ping`. Log `/var/log/mq-mariadb.log`.
- `/root/mq/start-app.sh`: FOREGROUND, `exec node .../next start -H 0.0.0.0 -p 3000` from `/root/app`
  with Node 18 and `LD_PRELOAD=.../libfaketime.so.1 FAKETIME_TIMESTAMP_FILE=/run/m/offset FAKETIME_NO_CACHE=1
  FAKETIME_DONT_FAKE_MONOTONIC=1 FAKETIME_DISABLE_SHM=1`. Creates `/run/m/offset` (`+0`) if missing.
  Background it yourself: `bash /root/mq/start-app.sh > /run/m/app.log 2>&1 &` or a managed process.
- `/root/mq/stop.sh`: kills the app (and its orphaned jest-worker children), deletes rows of
  posts/sessions/accounts/verification_tokens/users, `mysqladmin shutdown`, waits until nothing is left.
- `session.js`: reference only (engine has the agent write `/root/mq/session.js`).
  `cd /root/app && node session.js <email>` prints the value of cookie `next-auth.session-token`.

## Node on PATH

`prepare.sh` writes `/etc/profile.d/99-mq-node18.sh` (`PATH=/opt/n/bin:$PATH`), sorted after devbox's
`00-fcspawn-devbox.sh`. Verified: `bash -lc 'which node; node -v'` gives `/opt/n/bin/node v18.20.8`.
Non-login shells still get devbox Node 24 (`/usr/local/bin/node` -> asdf). asdf shims (claude, codex...) keep Node 24.

## .env (`/root/app/.env`, chmod 600)

Dummy values from prepare: NEXTAUTH_SECRET (random per VM), GITHUB_*=mannequin-dummy, SMTP_FROM,
POSTMARK_API_TOKEN=mannequin-dummy, POSTMARK_*_TEMPLATE=1, DATABASE_URL=mysql://mq:mq@127.0.0.1:3306/taxonomy,
STRIPE_API_KEY=sk_test_dummy, STRIPE_WEBHOOK_SECRET=whsec_dummy, STRIPE_PRO_MONTHLY_PLAN_ID=price_dummy,
NEXT_PUBLIC_APP_URL=NEXTAUTH_URL=http://localhost:3000.

A run must override (then restart the app; `next start` reads .env at boot, no rebuild needed for server vars):
- `STRIPE_API_KEY` (sk_test_...), `STRIPE_WEBHOOK_SECRET` (whsec_ of the run's endpoint),
  `STRIPE_PRO_MONTHLY_PLAN_ID` (the run's price id; the app says PRO iff `users.stripe_price_id` equals it
  and `stripe_current_period_end` > now).
- Optional: `NEXTAUTH_URL` / `NEXT_PUBLIC_APP_URL` if pages are fetched via the public URL
  (NEXT_PUBLIC_* is inlined at build time, so changing it only affects server code).

## Measured

| Step | Time |
|---|---|
| sandbox create | 0.5 s |
| prepare.sh on fresh VM | 137 s (apt 12, node18 8, clone 2, pnpm install 29, db push 4, contentlayer 5, next build 76) |
| prepare.sh re-run | 7 s |
| peak RAM during build (`free` used) | 2.7 GB of 3.9 GB, no NODE_OPTIONS problem (2048 MB cap set) |
| app ready after `start-app.sh` (warm) | ~4 s |
| pause (snapshot) | 50 to 53 s |
| fork (CLI returns, auto-resumed) | 54 s |
| fork running -> stop.sh + start-db + start-app + PRO page verified | 11.7 s |
| resume | 13.5 s |

## Verification results

1. `curl localhost:3000/dashboard/billing` without cookie: `307` -> `/login?from=%2Fdashboard%2Fbilling`.
2. User inserted with `INSERT INTO users (id,name,email,created_at,updated_at) VALUES ('cmqtest0001',...,NOW(),NOW())`
   (only id, email, created_at, updated_at matter; snake_case columns: stripe_customer_id, stripe_subscription_id,
   stripe_price_id, stripe_current_period_end). Forged cookie: 200, "You are currently on the Free plan".
   After `stripe_price_id='price_dummy'`, `stripe_current_period_end=NOW()+INTERVAL 10 DAY` (subscription id NULL):
   "PRO plan ... renews on October 27, 2026".
3. libfaketime: offset `+30d` or `+2592000` (seconds) -> `node -e 'new Date()'` under the preload prints +30 days.
   App keeps serving, and the same PRO user flips to "Free" at +30d (period end passed): time travel works end to end.
4. Public URL: format `https://<sandbox id without "sb-">-<port>.app.sb.createos.sh`,
   e.g. `https://01m55n6bhbjx89yq8sva1v28p7-8787.app.sb.createos.sh` (given as `ingress_url_template` by
   `create`/`get`/`fork`). Needs `--ingress` at create; forks inherit it. Port 3000 is reachable the same way.
5. Pause/fork: fork of mq-prep served the PRO page again after restarting DB and app.

## Fork recipe (what the engine does)

```
mkdir -p /run/m && echo +0 > /run/m/offset && bash /root/mq/start-db.sh
# edit /root/app/.env STRIPE_* here
bash /root/mq/start-app.sh > /run/m/app.log 2>&1 &     # or a managed process
until curl -s -o /dev/null localhost:3000/login; do sleep 0.2; done
```

## Gotchas

- No systemd in devbox (`systemctl` missing): MariaDB is started by hand via `mysqld_safe`.
- No `/usr/bin/time` in devbox; memory measured by sampling `free -m`.
- `npm i -g n` puts `n` outside PATH (asdf prefix): prepare calls `$(npm prefix -g)/bin/n`.
- `/usr/local/bin/node` is an asdf symlink to Node 24 and is first in PATH via devbox profile: hence the profile.d file.
- **Pause snapshots live memory: processes survive pause/resume/fork** (the fork had MariaDB and next start
  already running and answering 200). So always run `stop.sh` before pausing a clean snapshot. Upside: a snapshot
  with DB + app running would make a fork ready instantly (worth considering if the 12 s matter).
- `next start` spawns jest-worker children (`processChild.js`) that survive a `pkill` of the parent; stop.sh kills
  everything matching `/root/app/node_modules/`. Do not call stop.sh from a command line that contains that string.
- `pkill -f <pattern>` inside `createos sandbox exec ... bash -lc '...'` also kills the exec's own bash when the
  pattern appears in the command text (cost me one dirty snapshot).
- **Session cookie expiry vs fake time**: next-auth JWT `exp` = issue time + 30 days. A cookie forged at real time
  is rejected (307) once the app clock is past +30d. Forge it under the same LD_PRELOAD/offset as the app
  (verified: +40d, real-time cookie 307, cookie forged under faketime 200), or regenerate after every advance.
- `fork` has no name option: the fork gets a random name (e.g. `clever-pascal-8li7`); track it by id.
- `/run/m` is not a tmpfs here: it persists across pause/fork (contents of offset survive).
- contentlayer prints webpack cache warnings (`markdown-wasm/dist/markdown.node.js`) during next build: harmless.
- prisma 4.13 prints an "update available" banner: harmless.
- MariaDB user `mq` has `GRANT ALL ON *.*` (local only, bind 127.0.0.1) so prisma can do whatever it needs.
