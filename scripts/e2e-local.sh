#!/usr/bin/env bash
# Runs the Playwright suite against a Convex backend on this computer, so no
# run uses any of the Convex free plan's monthly allowance, which production
# and every cloud deployment share (docs/E2E-LOCAL.md).
#
#   scripts/e2e-local.sh e2e/quick.spec.ts --project=desktop
#
# Arguments go to `playwright test` as they are. The backend is started (and
# stopped at the end) unless it is already running; the app is built for it
# and served on :3100, as the suite expects. The build in .next is then the
# local backend's: `pnpm build` makes the usual one again.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.e2e-local
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE がありません。docs/E2E-LOCAL.md の「はじめに一度だけ」を済ませてください。" >&2
  exit 1
fi
# Only the addresses: the deployment itself is chosen by the env file.
CONVEX_URL=$(grep '^NEXT_PUBLIC_CONVEX_URL=' "$ENV_FILE" | cut -d= -f2-)
SITE_URL=$(grep '^NEXT_PUBLIC_CONVEX_SITE_URL=' "$ENV_FILE" | cut -d= -f2-)

LOGS=$(mktemp -d "${TMPDIR:-/tmp}/memoca-e2e-local.XXXX")
pids=()
started_backend=false
started_app=false
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  # The backend outlives the `convex dev` that started it: stopped by its port.
  if $started_backend; then
    lsof -ti "tcp:${CONVEX_URL##*:}" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  fi
  # So does `next start`'s server.
  if $started_app; then
    lsof -ti tcp:3100 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  fi
}
trap cleanup EXIT

if lsof -iTCP:3100 -sTCP:LISTEN >/dev/null 2>&1; then
  echo ":3100 は使用中です。止めてから、もう一度実行してください。" >&2
  exit 1
fi

# 1. The backend, with this checkout's functions pushed to it.
if ! curl -sf -o /dev/null "$CONVEX_URL/version"; then
  echo "手元の Convex を起動しています…"
  npx convex dev --env-file "$ENV_FILE" >"$LOGS/convex.log" 2>&1 &
  pids+=($!)
  started_backend=true
fi
for _ in $(seq 1 120); do
  if grep -q "Convex functions ready" "$LOGS/convex.log" 2>/dev/null; then break; fi
  if ! $started_backend && curl -sf -o /dev/null "$CONVEX_URL/version"; then break; fi
  if grep -q "✖" "$LOGS/convex.log" 2>/dev/null; then
    cat "$LOGS/convex.log" >&2
    exit 1
  fi
  sleep 2
done

# 2. The app, built against it and served where the suite looks.
echo "手元の Convex 向けにビルドしています…"
NEXT_PUBLIC_CONVEX_URL="$CONVEX_URL" NEXT_PUBLIC_CONVEX_SITE_URL="$SITE_URL" pnpm build >"$LOGS/build.log" 2>&1 ||
  { tail -30 "$LOGS/build.log" >&2; exit 1; }
pnpm start >"$LOGS/start.log" 2>&1 &
pids+=($!)
started_app=true
for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:3100 && break
  sleep 1
done

# 3. The suite.
E2E_BASE_URL=http://localhost:3100 npx playwright test "$@"
