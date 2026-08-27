#!/usr/bin/env bash
# Smoke test the container exactly as production runs it.
#
# The point of this script is that "the image built" and "the image works" are
# different claims, and only the second one matters. It checks the four things
# that actually break a deploy, in the order they break:
#
#   1. does the process start at all              (module resolution, env config)
#   2. is it reachable from outside the container (HOST binding)
#   3. does it serve both halves                  (API + the web bundle)
#   4. does it stop cleanly                       (SIGTERM handling)
#
# Run it locally before you push; CI runs the same checks.
set -euo pipefail

IMAGE="${IMAGE:-cookmate:local}"
NAME="cookmate-smoke"
PORT="${PORT:-8788}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "▸ starting $IMAGE"
docker run -d --name "$NAME" -p "${PORT}:8787" \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-fake-for-boot-check}" \
  -e DEV_ALLOW_ANONYMOUS=1 \
  -e DATABASE_PATH=/app/data/cookmate.db \
  -e HOST=0.0.0.0 \
  "$IMAGE" >/dev/null

echo "▸ waiting for liveness"
for _ in $(seq 1 30); do
  curl -sf "localhost:${PORT}/health" >/dev/null 2>&1 && break || sleep 1
done

fail() { echo "✗ $1"; docker logs "$NAME"; exit 1; }

curl -sf "localhost:${PORT}/health"  >/dev/null || fail "/health did not answer"
curl -sf "localhost:${PORT}/ready"   >/dev/null || fail "/ready did not answer"
curl -sf "localhost:${PORT}/version" >/dev/null || fail "/version did not answer"
curl -sf -o /dev/null "localhost:${PORT}/"      || fail "web bundle not served"

echo "▸ /version:"
curl -s "localhost:${PORT}/version" | sed 's/^/    /'
echo

echo "▸ non-root?"
[ "$(docker exec "$NAME" whoami)" = "node" ] || fail "container is not running as the node user"
echo "    running as node ✓"

echo "▸ graceful shutdown"
START=$(date +%s)
docker stop --timeout 40 "$NAME" >/dev/null
ELAPSED=$(( $(date +%s) - START ))
docker logs "$NAME" 2>&1 | grep -q "all requests drained" || fail "SIGTERM handler did not run"
[ "$ELAPSED" -lt 15 ] || fail "took ${ELAPSED}s — SIGTERM was ignored and Docker resorted to SIGKILL"
echo "    drained and exited in ${ELAPSED}s ✓"

echo
echo "✓ all smoke checks passed"
