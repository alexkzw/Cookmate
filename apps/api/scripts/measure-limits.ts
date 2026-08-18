/**
 * PROVE THE LIMITS FIRE — without paying to get there.
 *
 *   pnpm measure:limits            burst + concurrency (spends nothing)
 *   pnpm measure:limits --cap      also prove the cost cap (spends ~1 recipe)
 *
 * THE TRICK, AND IT IS THE WHOLE POINT OF THIS FILE:
 * the obvious way to test a limit is to generate enough load to hit it. At
 * ~$0.05 and 26 seconds a request, proving a 10/min limit that way costs money
 * and takes a minute. So instead, LOWER THE LIMIT TO MEET THE LOAD YOU ALREADY
 * HAVE. Boot the server with RATE_LIMIT_PER_MINUTE=1 and two requests prove the
 * policy — and the second one is refused before any model call, so it is free.
 *
 * That inversion generalises: a threshold is cheapest to test from the side you
 * control. It also means these runs are fast enough to keep in CI, where a
 * genuine load test would never live.
 *
 * Requires the API running with DEV_ALLOW_ANONYMOUS=1, which collapses every
 * caller onto one user id — exactly what you want when measuring a per-user cap.
 */

const BASE = process.env.API_BASE ?? "http://localhost:8787";
const withCap = process.argv.includes("--cap");

interface LimitStatus {
  spentUsd: number;
  reservedUsd: number;
  capUsd: number;
  remainingUsd: number;
  inFlight: number;
  maxConcurrent: number;
  requestsRemainingThisMinute: number;
  requestsPerMinute: number;
  globalSpentUsd: number;
  globalCapUsd: number;
}

const status = async (): Promise<LimitStatus> =>
  (await fetch(`${BASE}/api/limits`).then((r) => r.json())) as LimitStatus;

/** One generation request. Returns as soon as headers land, not at stream end. */
async function fire(craving: string): Promise<{ status: number; code?: string; body: string }> {
  const res = await fetch(`${BASE}/api/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ craving, servings: 2, maxMinutes: 30, effort: "moderate", willShop: false }),
  });
  if (res.status !== 200) {
    const body = (await res.json()) as { error?: string; code?: string };
    return { status: res.status, code: body.code, body: body.error ?? "" };
  }
  // Drain and discard. We are measuring admission, not output.
  await res.body?.cancel();
  return { status: 200, body: "(stream opened)" };
}

function show(label: string, s: LimitStatus): void {
  console.log(
    `  ${label.padEnd(22)} spent $${s.spentUsd.toFixed(4)} + reserved $${s.reservedUsd.toFixed(4)} ` +
      `of $${s.capUsd.toFixed(2)} · in-flight ${s.inFlight}/${s.maxConcurrent} · ` +
      `${s.requestsRemainingThisMinute}/${s.requestsPerMinute} req left this minute`,
  );
}

async function main(): Promise<void> {
  const start = await status();
  console.log(`\nconfigured: ${start.requestsPerMinute}/min · ${start.maxConcurrent} concurrent · ` +
    `$${start.capUsd.toFixed(2)}/user/day · $${start.globalCapUsd.toFixed(2)}/day global`);
  show("before", start);

  // ---- 1. CONCURRENCY -----------------------------------------------------
  // Fire maxConcurrent+1 at once. The extra one must be refused, and refused
  // BEFORE the model is called — so this costs the price of maxConcurrent
  // generations, and nothing for the refusals. Set MAX_CONCURRENT_PER_USER=1
  // to make that one generation instead of two.
  console.log(`\n[1] concurrency — firing ${start.maxConcurrent + 1} at once`);
  const burst = await Promise.all(
    Array.from({ length: start.maxConcurrent + 1 }, (_, i) => fire(`concurrency probe ${i}`)),
  );
  for (const [i, r] of burst.entries()) {
    console.log(`  #${i + 1}  ${r.status}${r.code ? ` ${r.code}` : ""}  ${r.body}`);
  }
  const refusedConcurrent = burst.filter((r) => r.code === "concurrency").length;
  console.log(refusedConcurrent > 0
    ? `  PASS — ${refusedConcurrent} refused on concurrency`
    : `  NO SIGNAL — nothing refused. Lower MAX_CONCURRENT_PER_USER and re-run.`);

  // ---- 2. RATE LIMIT ------------------------------------------------------
  // Sequential, so concurrency can't be what refuses them. Every request past
  // the allowance is refused before any model call: free.
  console.log(`\n[2] rate limit — firing ${start.requestsPerMinute + 2} sequentially`);
  let refusedRate = 0;
  for (let i = 0; i < start.requestsPerMinute + 2; i += 1) {
    const r = await fire(`rate probe ${i}`);
    if (r.code === "rate_limit") refusedRate += 1;
    console.log(`  #${i + 1}  ${r.status}${r.code ? ` ${r.code}` : ""}`);
  }
  console.log(refusedRate > 0
    ? `  PASS — ${refusedRate} refused on rate`
    : `  NO SIGNAL — nothing refused. Set RATE_LIMIT_PER_MINUTE=1 and re-run.`);

  // ---- 3. COST CAP --------------------------------------------------------
  // The only step that must actually spend. Boot with DAILY_COST_CAP_USD=0.01
  // and ONE completed generation puts you over — so the cap is proven for the
  // price of a single recipe rather than a day's worth.
  if (withCap) {
    console.log(`\n[3] cost cap — spending until refused (cap $${start.capUsd.toFixed(2)})`);
    if (start.capUsd > 0.5) {
      console.log(`  SKIPPED — cap is $${start.capUsd.toFixed(2)}, which would cost ~$${start.capUsd.toFixed(2)} to reach.`);
      console.log(`  Restart the API with DAILY_COST_CAP_USD=0.01 and re-run.`);
    } else {
      for (let i = 0; i < 5; i += 1) {
        const r = await fire(`cap probe ${i}`);
        console.log(`  #${i + 1}  ${r.status}${r.code ? ` ${r.code}` : ""}  ${r.body}`);
        if (r.code === "user_daily_cap") {
          console.log(`  PASS — refused after $${(await status()).spentUsd.toFixed(4)} of spend`);
          break;
        }
        // A stream that was opened is still being billed. Wait for it to land
        // in `turns`, or the next check reads a spend total that hasn't arrived.
        await new Promise((r2) => setTimeout(r2, 30_000));
      }
    }
  } else {
    console.log(`\n[3] cost cap — skipped. Re-run with --cap (spends ~1 recipe).`);
  }

  show("after", await status());
  console.log(`\nRefusals are persisted: GET ${BASE}/api/stats -> limitEvents\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
