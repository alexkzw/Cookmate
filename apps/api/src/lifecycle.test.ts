import { describe, it, expect, beforeEach } from "vitest";
import {
  beginWork,
  beginDraining,
  isDraining,
  inFlightCount,
  waitForDrain,
  resetLifecycle,
} from "./lifecycle.js";

/**
 * The bug these guard against is not "the counter arithmetic is wrong" — it is
 * "the counter was read at the wrong moment." So the important test is the last
 * one: work that outlives the call that started it must still hold the drain
 * open. That is the shape of an SSE stream, and it is the case the middleware
 * version got wrong in production.
 */

beforeEach(() => resetLifecycle());

describe("beginWork", () => {
  it("counts up and back down", () => {
    expect(inFlightCount()).toBe(0);
    const a = beginWork();
    const b = beginWork();
    expect(inFlightCount()).toBe(2);
    a();
    expect(inFlightCount()).toBe(1);
    b();
    expect(inFlightCount()).toBe(0);
  });

  /**
   * A double release would push the count below the truth and let the drain
   * exit while work is still running — the same failure as the original bug,
   * arriving from the opposite direction.
   */
  it("is idempotent, so a double release cannot undercount", () => {
    const done = beginWork();
    expect(inFlightCount()).toBe(1);
    done();
    done();
    done();
    expect(inFlightCount()).toBe(0);
  });

  it("never goes negative across interleaved work", () => {
    const a = beginWork();
    const b = beginWork();
    a();
    a();
    expect(inFlightCount()).toBe(1);
    b();
    expect(inFlightCount()).toBe(0);
  });
});

describe("draining", () => {
  it("starts false and latches true", () => {
    expect(isDraining()).toBe(false);
    beginDraining();
    expect(isDraining()).toBe(true);
  });
});

describe("waitForDrain", () => {
  it("returns immediately when nothing is running", async () => {
    const started = Date.now();
    await expect(waitForDrain(5_000)).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("waits for work to finish and reports success", async () => {
    const done = beginWork();
    setTimeout(done, 120);
    await expect(waitForDrain(5_000, 20)).resolves.toBe(true);
    expect(inFlightCount()).toBe(0);
  });

  it("gives up at the deadline and reports failure", async () => {
    beginWork(); // never released — simulates a wedged request
    const started = Date.now();
    await expect(waitForDrain(200, 20)).resolves.toBe(false);
    // Bounded: SIGKILL arrives on the platform's schedule regardless, so this
    // must not wait indefinitely for work that is never going to finish.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(inFlightCount()).toBe(1);
  });

  /**
   * THE REGRESSION TEST FOR THE PRODUCTION BUG.
   *
   * A streamed route's handler returns almost immediately while the stream
   * keeps producing for another ~26 seconds. Counting at handler-return made
   * the drain see zero and exit, killing the stream. Work registered for the
   * STREAM's lifetime must still hold the drain open after the function that
   * started it has long since returned.
   */
  it("holds the drain open for work that outlives the call that started it", async () => {
    // Mimics `streamSSE`: returns straight away, keeps working in the
    // background. The old middleware counted only the part before the return.
    function startStream(): void {
      const done = beginWork();
      setTimeout(done, 150);
    }

    startStream();
    // The "handler" has already returned here — this is the exact moment the
    // broken version dropped the count to zero.
    expect(inFlightCount()).toBe(1);

    const drained = await waitForDrain(2_000, 20);
    expect(drained).toBe(true);
  });
});
