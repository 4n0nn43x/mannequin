#!/usr/bin/env bash
# Turns a fresh CreateOS devbox:1 (Ubuntu 24.04, root, no systemd) into a ready
# shadcn-ui/taxonomy app: MariaDB + Node 18 + pnpm 8 + built Next app.
# Idempotent: safe to re-run. Runs INSIDE the VM as root.
# Usage: REPO=<git url> bash /root/mq/prepare.sh   (REPO defaults to shadcn-ui/taxonomy)
# Writes helpers /root/mq/start-db.sh, start-app.sh, stop.sh and makes Node 18 the
# default `node` for login shells (bash -lc). See vm/README.md.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive NEXT_TELEMETRY_DISABLED=1
APP=/root/app
REPO=${REPO:-https://github.com/shadcn-ui/taxonomy}
REF=${REF:-}                     # optional commit to pin
MQ=/root/mq
NODE_DIR=/opt/n                  # Node 18 lives here; system Node 24 stays untouched
export PATH=$NODE_DIR/bin:$PATH
mkdir -p $MQ /run/m
log() { echo "[prepare $(date +%T)] $*"; }

# 1. System packages
if ! command -v mariadbd >/dev/null || ! [ -e /usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1 ]; then
  log "apt install"
  apt-get update -qq
  apt-get install -y -qq mariadb-server faketime git curl ca-certificates >/dev/null
fi

# 2. MariaDB low-memory config + start helper
cat > /etc/mysql/mariadb.conf.d/99-mq.cnf <<'CNF'
[mysqld]
bind-address=127.0.0.1
innodb_buffer_pool_size=32M
performance_schema=OFF
key_buffer_size=8M
max_connections=50
CNF
cat > $MQ/start-db.sh <<'SH'
#!/usr/bin/env bash
# Start MariaDB at REAL time (never under libfaketime) and wait until it answers.
mysqladmin ping >/dev/null 2>&1 && exit 0
mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld
env -u LD_PRELOAD setsid nohup mysqld_safe >/var/log/mq-mariadb.log 2>&1 < /dev/null &
for i in $(seq 1 60); do mysqladmin ping >/dev/null 2>&1 && exit 0; sleep 0.5; done
echo "mariadb did not start, see /var/log/mq-mariadb.log and /var/log/mysql/" >&2; exit 1
SH
chmod +x $MQ/start-db.sh
log "start mariadb"; bash $MQ/start-db.sh
mysql -uroot <<'SQL'
CREATE DATABASE IF NOT EXISTS taxonomy;
CREATE USER IF NOT EXISTS 'mq'@'127.0.0.1' IDENTIFIED BY 'mq';
CREATE USER IF NOT EXISTS 'mq'@'localhost' IDENTIFIED BY 'mq';
GRANT ALL ON *.* TO 'mq'@'127.0.0.1';
GRANT ALL ON *.* TO 'mq'@'localhost';
FLUSH PRIVILEGES;
SQL
# GRANT ALL ON *.* because prisma db push may want a shadow db / CREATE DATABASE.

# 3. Node 18 + pnpm 8 (contentlayer 0.3.x breaks on Node 20+)
if ! [ -x $NODE_DIR/bin/node ] || ! $NODE_DIR/bin/node -v | grep -q '^v18'; then
  log "install node 18"
  npm i -g n >/dev/null 2>&1
  N_PREFIX=$NODE_DIR "$(npm prefix -g)/bin/n" 18 >/dev/null
fi
# Login shells (bash -lc) get Node 18 first; 99- sorts after devbox's 00-fcspawn-devbox.sh
echo "export PATH=$NODE_DIR/bin:\$PATH" > /etc/profile.d/99-mq-node18.sh
$NODE_DIR/bin/npm ls -g pnpm 2>/dev/null | grep -q 'pnpm@8' || $NODE_DIR/bin/npm i -g pnpm@8 >/dev/null
log "node $(node -v), pnpm $(pnpm -v)"

# 4. Source
if ! [ -d $APP/.git ]; then
  log "clone"; git clone -q --filter=blob:none "$REPO" $APP
  [ -n "$REF" ] && git -C $APP checkout -q "$REF"
fi
log "taxonomy commit $(git -C $APP rev-parse --short HEAD)"

# 5. .env (dummy values; a run overrides STRIPE_* / NEXT_PUBLIC_APP_URL / NEXTAUTH_URL)
if ! [ -f $APP/.env ]; then
  SECRET=$(head -c 32 /dev/urandom | base64)
  cat > $APP/.env <<ENV
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=$SECRET
GITHUB_CLIENT_ID=mannequin-dummy
GITHUB_CLIENT_SECRET=mannequin-dummy
GITHUB_ACCESS_TOKEN=mannequin-dummy
DATABASE_URL=mysql://mq:mq@127.0.0.1:3306/taxonomy
SMTP_FROM=mannequin@example.com
POSTMARK_API_TOKEN=mannequin-dummy
POSTMARK_SIGN_IN_TEMPLATE=1
POSTMARK_ACTIVATION_TEMPLATE=1
STRIPE_API_KEY=sk_test_dummy
STRIPE_WEBHOOK_SECRET=whsec_dummy
STRIPE_PRO_MONTHLY_PLAN_ID=price_dummy
ENV
  chmod 600 $APP/.env
fi

# 6. Deps, schema, build (all at real time)
cd $APP
log "pnpm install"; pnpm install --frozen-lockfile --reporter=silent
log "prisma db push"; npx prisma db push --skip-generate --accept-data-loss; npx prisma generate >/dev/null
export NODE_OPTIONS=--max-old-space-size=2048
log "contentlayer build"; pnpm contentlayer build || log "contentlayer exited non-zero (often harmless), checking output"
[ -d .contentlayer/generated ] || { echo "contentlayer produced nothing" >&2; exit 1; }
if ! [ -f .next/BUILD_ID ] || [ -n "${FORCE_BUILD:-}" ]; then
  log "next build"; pnpm next build
fi

# 7. App helpers
[ -f /run/m/offset ] || echo +0 > /run/m/offset
cat > $MQ/start-app.sh <<'SH'
#!/usr/bin/env bash
# Foreground: exec `next start` (and ONLY it) under libfaketime. Simulated clock =
# real time + contents of /run/m/offset (+0, +2592000, +30d...), re-read on every call.
mkdir -p /run/m; [ -f /run/m/offset ] || echo +0 > /run/m/offset
cd /root/app
export PATH=/opt/n/bin:$PATH NEXT_TELEMETRY_DISABLED=1
export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1 FAKETIME_TIMESTAMP_FILE=/run/m/offset \
  FAKETIME_NO_CACHE=1 FAKETIME_DONT_FAKE_MONOTONIC=1 FAKETIME_DISABLE_SHM=1
exec node node_modules/next/dist/bin/next start -H 0.0.0.0 -p 3000
SH
cat > $MQ/stop.sh <<'SH'
#!/usr/bin/env bash
# Kill the app, wipe per-run tables, stop MariaDB cleanly (state before a snapshot/pause).
# next start leaves jest-worker children (processChild.js): kill everything running from the app tree
pkill -f 'next/dist/bin/next start|/root/app/node_modules/' || true
if mysqladmin ping >/dev/null 2>&1; then
  mysql -uroot taxonomy -e 'SET FOREIGN_KEY_CHECKS=0; DELETE FROM posts; DELETE FROM sessions; DELETE FROM accounts; DELETE FROM verification_tokens; DELETE FROM users; SET FOREIGN_KEY_CHECKS=1;'
  mysqladmin -uroot shutdown
fi
for i in $(seq 1 40); do pgrep -f 'mariadbd|mysqld_safe|next/dist/bin/next start|/root/app/node_modules/' >/dev/null || exit 0; sleep 0.25; done
echo "processes still alive after stop" >&2; exit 1
SH
chmod +x $MQ/start-app.sh $MQ/stop.sh
log "done. Start with: bash $MQ/start-db.sh && (bash $MQ/start-app.sh > /run/m/app.log 2>&1 &)"
