/**
 * IN-FLIGHT WORK TRACKING, for graceful shutdown.
 *
 * This module exists because of a bug that only a real deployment could have
 * found, and the bug is worth writing down because the trap is subtle and this
 * codebase has now hit it twice.
 *
 * THE MISTAKE
 * The first version counted requests in Hono middleware:
 *
 *     app.use("*", async (c, next) => {
 *       inFlight += 1;
 *       try { await next(); } finally { inFlight -= 1; }
 *     });
 *
 * That is correct for a normal JSON route and WRONG for a streamed one. With
 * `streamSSE`, the handler returns as soon as the stream is established — the
 * body is produced afterwards, from a ReadableStream the runtime pulls on. So
 * `await next()` resolves in milliseconds while the generation runs for another
 * ~26 seconds. Hono's own logger shows it plainly:
 *
 *     <-- POST /api/chat/stream
 *     --> POST /api/chat/stream 200 25ms      <- still streaming for 26 more
 *
 * The consequence was that the shutdown drain believed zero requests were in
 * flight and exited immediately, killing exactly the long-lived streams it was
 * written to protect. Verified on Fly: a machine restart during a live
 * generation logged `0 request(s) in flight` and the client got
 * `INTERNAL_ERROR` mid-stream.
 *
 * THE SAME TRAP, ALREADY DOCUMENTED
 * `routes/chat.ts` releases the budget lease in the ROUTE's `finally` rather
 * than the middleware's, with a comment explaining that `next()` returns when
 * the stream starts. That was the identical hazard, found earlier, in a
 * different mechanism — and the shutdown counter walked straight into it
 * anyway. Two independent bugs from one misunderstanding is the signal that the
 * concept deserved a module rather than a comment.
 *
 * THE RULE
 * Track work where the WORK is, never where the request is. For anything
 * streamed, that means inside the stream callback, whose lifetime is the work's
 * lifetime.
 */

let inFlight = 0;
let draining = false;

/**
 * Register a unit of in-flight work. Call the returned function when it ends.
 *
 * The release is IDEMPOTENT. A double release would decrement the counter below
 * the true value and let the drain exit while work is still running — the same
 * class of failure this module exists to fix, arriving from the opposite
 * direction. Cheap to make impossible, so it is.
 */
export function beginWork(): () => void {
  inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
  };
}

/** How many units of work are running right now. */
export function inFlightCount(): number {
  return inFlight;
}

/**
 * Is the process shutting down?
 *
 * Read by `/ready`, which returns 503 once this is true so the load balancer
 * stops routing new work here while the existing work finishes.
 */
export function isDraining(): boolean {
  return draining;
}

export function beginDraining(): void {
  draining = true;
}

/**
 * Wait for in-flight work to finish, bounded.
 *
 * Returns true if everything drained, false if the deadline arrived first. The
 * bound is not optional: SIGKILL lands on the platform's schedule whether we
 * are finished or not, so this timeout must sit INSIDE that window — otherwise
 * the careful shutdown is interrupted by the very thing it exists to pre-empt.
 */
export async function waitForDrain(timeoutMs: number, pollMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return inFlight === 0;
}

/** Test seam. Never called in production code. */
export function resetLifecycle(): void {
  inFlight = 0;
  draining = false;
}
