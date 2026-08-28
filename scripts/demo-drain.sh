#!/usr/bin/env bash
#
# Demonstrate graceful shutdown against the live deployment.
#
# WHAT THIS PROVES
# A shutdown signal arrives while a ~26-second recipe generation is streaming,
# and the client still receives its complete recipe. That is the whole claim:
# a deploy does not drop work that has already been paid for.
#
# WHY IT NEEDS A SCRIPT RATHER THAN THREE COMMANDS
# The naive version — start a request, `sleep 5`, restart — has a race that is
# invisible until it bites. With `auto_stop_machines` on, an idle machine is
# STOPPED. The first request has to wake it, which takes several seconds, so the
# five second head start gets spent on the cold start instead of on the
# generation. The restart then fires before the request has even reached the
# app, and the drain correctly reports zero requests in flight because there
# genuinely were none. The demo looks broken while everything works.
#
# Observed on 2026-08-28: restart at 03:32:08, request arrived 03:32:23. Fifteen
# seconds apart, never overlapping.
#
# So this script does two things the manual version cannot:
#   1. WARMS the machine first and waits for it to actually serve, so the cold
#      start is over before the clock that matters starts.
#   2. Waits for a real `delta` event rather than sleeping a fixed time — proof
#      the model is mid-response, not a guess that it probably is by now.
set -euo pipefail

APP="${APP:-cookmate}"
URL="${URL:-https://cookmate.fly.dev}"
OUT="$(mktemp -t cookmate-drain)"
cleanup() { rm -f "$OUT"; }
trap cleanup EXIT

echo "▸ waking the machine (it auto-stops when idle)"
for i in $(seq 1 30); do
  if curl -sf --max-time 10 "$URL/health" >/dev/null 2>&1; then
    echo "  awake after ${i}s"
    break
  fi
  sleep 1
done
curl -sf --max-time 10 "$URL/health" >/dev/null || { echo "✗ never became healthy"; exit 1; }

# Readiness, not just liveness: /health says the process is alive, /ready says
# it will actually be given traffic. Starting the demo between those two states
# is another way to arrive early.
echo "▸ waiting for readiness"
for _ in $(seq 1 20); do
  curl -sf --max-time 5 "$URL/ready" >/dev/null 2>&1 && break || sleep 1
done

MACHINE=$(fly machine list --app "$APP" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')
echo "▸ machine $MACHINE is serving"

echo "▸ starting a recipe generation"
curl -sN -X POST "$URL/api/chat/stream" \
  -H 'Content-Type: application/json' \
  -d '{"craving":"something warming with lentils"}' > "$OUT" 2>&1 &
CURL_PID=$!

# Wait for evidence the model is actually producing tokens. `start` only means
# the turn row was opened; `delta` means the generation is genuinely under way,
# which is the state the shutdown has to survive.
echo "▸ waiting for the stream to produce tokens"
for i in $(seq 1 40); do
  if grep -q '"type":"delta"' "$OUT" 2>/dev/null; then
    echo "  streaming after ${i}s"
    break
  fi
  sleep 1
done

if ! grep -q '"type":"delta"' "$OUT" 2>/dev/null; then
  echo "✗ the stream never started producing — nothing to interrupt"
  kill $CURL_PID 2>/dev/null || true
  exit 1
fi

echo "▸ restarting the machine MID-STREAM — this is the moment that matters"
fly machine restart "$MACHINE" --app "$APP" >/dev/null 2>&1 &
RESTART_PID=$!

# Let the interrupted request finish on its own terms.
wait $CURL_PID 2>/dev/null || true
wait $RESTART_PID 2>/dev/null || true

echo
echo "──────────────── RESULT ────────────────"
if grep -q '"type":"done"' "$OUT"; then
  TITLE=$(python3 -c "
import json,sys
for line in open('$OUT'):
    if line.startswith('data: '):
        try: e=json.loads(line[6:])
        except Exception: continue
        if e.get('type')=='recipe': print(e['recipe']['title']); break
" 2>/dev/null || echo "(unparsed)")
  echo "✓ the request SURVIVED the shutdown"
  echo "  recipe: $TITLE"
  echo
  echo "Now confirm the server side — look for '1 request(s) in flight':"
  echo "  fly logs --app $APP | grep shutdown"
else
  echo "✗ the stream did not complete. Last events received:"
  grep -o '"type":"[a-z]*"' "$OUT" | sort | uniq -c
fi
