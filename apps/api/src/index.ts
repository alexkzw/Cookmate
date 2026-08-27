import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { chatRoutes } from "./routes/chat.js";
import { pantryRoutes } from "./routes/pantry.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { statsRoutes } from "./routes/stats.js";
import { limitRoutes } from "./routes/limits.js";
import { describeModel } from "./llm/models.js";
import { db } from "./db/index.js"; // importing runs migrations at boot
import { promptHash } from "./llm/prompts.js";
import { SCORER_HASH } from "./verify/provenance.js";
import { providerBreaker } from "./limits/breaker.js";

const app = new Hono();

app.use("*", logger());

/**
 * CORS is only needed when the browser and the API are on different origins.
 *
 * In development they are: Vite serves the app on :5173 and the API listens on
 * :8787, so every request is cross-origin and the browser demands permission.
 * In production this process serves BOTH — the built React bundle and the API
 * come off the same origin, so no preflight ever happens and this middleware is
 * inert.
 *
 * Keeping it configured rather than deleting it means a split deployment (CDN
 * for the front end, this for the API) stays one env var away.
 */
app.use(
  "/api/*",
  cors({
    origin: config.CORS_ORIGIN.split(",").map((s) => s.trim()),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  }),
);

/* ------------------------------------------------------------------ *
 * Lifecycle: draining, liveness, readiness
 * ------------------------------------------------------------------ */

/**
 * In-flight request tracking, so a deploy can wait for work to finish.
 *
 * This matters more here than in a typical API. A Cookmate turn holds its
 * connection for ~26 seconds and has already spent real money by the time it
 * is half done. Killing the process the instant a deploy starts would bill the
 * user for a recipe they never receive — and the turn row would be left open,
 * so the telemetry would record a generation that simply stops existing.
 */
let inFlight = 0;
let draining = false;

app.use("*", async (c, next) => {
  inFlight += 1;
  try {
    await next();
  } finally {
    inFlight -= 1;
  }
});

/**
 * LIVENESS — "is this process alive?"
 *
 * Deliberately cheap and dependency-free. The orchestrator RESTARTS the
 * container when this fails, so it must only report on the process itself. If
 * it checked the database, a transient disk problem would be answered by
 * killing a healthy server, which fixes nothing and drops every in-flight
 * stream. Liveness answers one question: is the event loop still turning?
 */
app.get("/health", (c) => c.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }));

/**
 * READINESS — "should this process receive traffic right now?"
 *
 * A different question with a different consequence: a failing readiness probe
 * takes the instance OUT OF THE LOAD BALANCER without restarting it. That makes
 * it the right place for dependency checks, and the right place to say "I am
 * shutting down" — which is what makes a zero-downtime deploy possible. The
 * moment SIGTERM arrives this returns 503, the router stops sending new work,
 * and the existing streams get to finish.
 */
app.get("/ready", (c) => {
  if (draining) {
    return c.json({ ready: false, reason: "shutting_down", inFlight }, 503);
  }
  try {
    // Cheapest possible proof that the database file is open and answering.
    db.prepare("SELECT 1").get();
  } catch (err) {
    return c.json(
      { ready: false, reason: "database_unavailable", error: String(err) },
      503,
    );
  }
  return c.json({
    ready: true,
    inFlight,
    // The breaker's view of the upstream. Not a reason to fail readiness — the
    // app still serves the pantry, the shopping list and /api/stats during a
    // provider outage — but it is the first thing you want when a deploy looks
    // sick, and it saves an SSH session to find out.
    provider: providerBreaker.snapshot(),
  });
});

/**
 * BUILD IDENTITY — which code is actually running.
 *
 * The single most useful endpoint during an incident. "Did my fix deploy?" is
 * otherwise answered by guessing, and the honest answer is often "no, the
 * rollout failed and you have been reading logs from the old revision".
 *
 * `promptHash` and `scorerHash` are here for a reason specific to this app: the
 * two things that decide what a recipe looks like and whether it passes are the
 * prompt and the verifier, and both are content-hashed. A production incident
 * about recipe quality starts by checking that these match the eval run you
 * trusted.
 */
app.get("/version", (c) =>
  c.json({
    gitSha: process.env.GIT_SHA ?? "unknown",
    builtAt: process.env.BUILD_TIME ?? "unknown",
    model: config.RECIPE_MODEL,
    effort: config.RECIPE_EFFORT,
    tier: describeModel(config.RECIPE_MODEL)?.tier ?? "unknown",
    promptHash: promptHash(),
    scorerHash: SCORER_HASH,
    authMode: config.DEV_ALLOW_ANONYMOUS ? "dev-anonymous" : "supabase-jwt",
  }),
);

app.route("/api/chat", chatRoutes);
app.route("/api/pantry", pantryRoutes);
app.route("/api/feedback", feedbackRoutes);
app.route("/api/stats", statsRoutes);
app.route("/api/limits", limitRoutes);

/* ------------------------------------------------------------------ *
 * The front end
 * ------------------------------------------------------------------ */

/**
 * Serve the built React app from this same process, when it exists.
 *
 * One origin, one deploy, one thing to roll back. The alternative — a static
 * host for the bundle and a separate API — is what large teams do, and it buys
 * a CDN and independent deploys at the cost of CORS, a second pipeline, and a
 * window where the two halves are running mismatched versions of the shared
 * schema. For a single service whose whole argument is that the schema exists
 * exactly once, shipping both halves together is the consistent choice.
 *
 * Guarded by `existsSync` so the API still starts when the bundle has not been
 * built — which is every local `pnpm dev`, where Vite serves the app instead.
 */
const WEB_ROOT = "./public";
if (existsSync(WEB_ROOT)) {
  app.use("/assets/*", serveStatic({ root: WEB_ROOT }));
  app.use("/*", serveStatic({ root: WEB_ROOT }));
  // SPA fallback: any unmatched path is a client-side route, so hand back the
  // shell and let React resolve it. Without this a refresh on any deep link 404s.
  app.get("*", serveStatic({ path: `${WEB_ROOT}/index.html` }));
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

if (config.DEV_ALLOW_ANONYMOUS) {
  console.warn("⚠️  DEV_ALLOW_ANONYMOUS=1 — auth is bypassed. Never run this in production.");
}

const server = serve(
  {
    fetch: app.fetch,
    port: config.PORT,
    /**
     * BIND 0.0.0.0, NOT localhost.
     *
     * Inside a container, `127.0.0.1` is the container's own loopback. A server
     * bound there is unreachable from the host no matter how the port is
     * published — the request arrives at the container's external interface and
     * finds nothing listening. It is the single most common reason a Docker
     * image that "works locally" answers nothing once containerised, and it
     * produces a connection refused rather than an error you can grep for.
     */
    hostname: config.HOST,
  },
  (info) => {
    console.log(`cookmate api → http://${config.HOST}:${info.port}`);
    console.log(`  model: ${config.RECIPE_MODEL} (effort: ${config.RECIPE_EFFORT})`);
    console.log(`  prompt ${promptHash()} · scorer ${SCORER_HASH}`);
  },
);

/**
 * GRACEFUL SHUTDOWN.
 *
 * Every orchestrator — Docker, Kubernetes, Fly, ECS — stops a container the
 * same way: send SIGTERM, wait a grace period, then SIGKILL. What a process
 * does in that gap is the difference between a deploy nobody notices and a
 * deploy that drops requests.
 *
 * The default behaviour of an unhandled SIGTERM is immediate death. For a
 * normal JSON API that costs one retry. Here it kills ~26-second SSE streams
 * that have already been billed, leaves their turn rows open forever, and
 * strands their budget leases until expiry.
 *
 * The sequence:
 *   1. flip `draining` so /ready starts returning 503 and the load balancer
 *      stops routing new requests here
 *   2. stop accepting new connections
 *   3. wait for in-flight work to finish, bounded
 *   4. close the database cleanly so SQLite's WAL is checkpointed
 *
 * The bound matters. SIGKILL arrives on the platform's schedule whether we are
 * finished or not, so the timeout must sit INSIDE that window — otherwise the
 * careful shutdown is interrupted by the thing it was meant to pre-empt.
 */
const SHUTDOWN_GRACE_MS = 30_000; // Fly/K8s default is 30s; stay under it.
const POLL_MS = 250;

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second Ctrl-C must not race the first
  shuttingDown = true;
  draining = true;

  console.log(`[shutdown] ${signal} received · ${inFlight} request(s) in flight`);

  server.close(() => console.log("[shutdown] stopped accepting connections"));

  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (inFlight > 0) {
    // Say so rather than exiting quietly. A truncated stream that nobody
    // recorded is indistinguishable from a bug in the model call.
    console.warn(`[shutdown] grace period expired with ${inFlight} request(s) still running`);
  } else {
    console.log("[shutdown] all requests drained");
  }

  try {
    // Checkpoints the WAL and releases the file lock. Skipping this leaves a
    // -wal file that the next boot has to recover, which is survivable but
    // slower — and on a volume that was force-detached, occasionally not.
    db.close();
    console.log("[shutdown] database closed");
  } catch (err) {
    console.error("[shutdown] database close failed:", err);
  }

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM")); // orchestrators
process.on("SIGINT", () => void shutdown("SIGINT")); // Ctrl-C

/**
 * Crash loudly on a programming error, rather than limping.
 *
 * A process that has thrown an unhandled rejection is in a state nobody
 * reasoned about. Staying alive means serving requests from it — the
 * orchestrator's restart is the safer outcome, and the log line is what makes
 * it debuggable rather than mysterious.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception:", err);
  process.exit(1);
});
