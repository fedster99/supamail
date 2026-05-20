#!/usr/bin/env bash
set -euo pipefail

INSTALL_CMD="${INSTALL_CMD:-pnpm install --frozen-lockfile}"
RUN_LIVE_DB="${RUN_LIVE_DB:-0}"

echo "== SupaMail init =="
echo "cwd: $(pwd)"

echo "== Install dependencies =="
bash -lc "$INSTALL_CMD"

echo "== Harness impact check =="
pnpm harness:check

echo "== Typecheck =="
pnpm typecheck

echo "== Unit and fast integration tests =="
pnpm test

echo "== Build =="
pnpm build

if [[ "$RUN_LIVE_DB" == "1" ]]; then
  echo "== Live DB reliability gate =="
  pnpm test:db:live
else
  echo "== Live DB reliability gate skipped =="
  echo "Set RUN_LIVE_DB=1 ./init.sh for sync/schema/repository/lock/reconcile/health changes."
fi

echo "== Verification complete =="
