import { describe, it, expect } from "vitest";
import type { CookRequest } from "@cookmate/shared";
import { buildPromptBlocks } from "./generate.js";

/**
 * These assert the cache-control LAYOUT, not the model's behaviour.
 *
 * The TTL-ordering rule is enforced by the API at request time, which is the
 * most expensive possible place to find out you got it wrong: it costs a round
 * trip, it only shows up when a request carries two breakpoints, and it
 * surfaces as a 400 in the middle of a user's follow-up.
 */

const request: CookRequest = {
  craving: "something warm with salmon",
  servings: 2,
  maxMinutes: 30,
  effort: "moderate",
  willShop: false,
  pantry: ["salmon fillets", "rice"],
  dislikes: [],
  dietary: [],
  cookware: ["stovetop"],
};

const history = [
  { userTurn: "Craving: pasta", recipeJson: '{"title":"Pasta"}' },
  { userTurn: "Craving: make it faster", recipeJson: '{"title":"Faster pasta"}' },
];

/** Every cache_control TTL in render order: tools → system → messages. */
function ttlsInOrder(blocks: ReturnType<typeof buildPromptBlocks>): string[] {
  const out: string[] = [];
  for (const block of blocks.system) {
    if (block.cache_control) out.push(block.cache_control.ttl ?? "5m");
  }
  for (const message of blocks.messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if ("cache_control" in block && block.cache_control) {
        out.push(block.cache_control.ttl ?? "5m");
      }
    }
  }
  return out;
}

const RANK: Record<string, number> = { "5m": 1, "1h": 2 };

describe("prompt cache layout", () => {
  it("puts exactly one breakpoint on a single-turn request", () => {
    // No prior conversation to read, so a second marker would buy a write
    // premium and nothing else.
    const blocks = buildPromptBlocks(request);
    expect(ttlsInOrder(blocks)).toHaveLength(1);
    expect(blocks.messages).toHaveLength(1);
  });

  it("adds a second breakpoint on the newest turn once there is history", () => {
    const blocks = buildPromptBlocks(request, { history });
    expect(ttlsInOrder(blocks)).toHaveLength(2);
    // 2 history turns => 4 messages, plus the new one.
    expect(blocks.messages).toHaveLength(5);
  });

  it("never lets a longer TTL follow a shorter one", () => {
    // The exact rule the API enforces: "a ttl='1h' cache_control block must not
    // come after a ttl='5m' cache_control block". Shipping 5m on system and 1h
    // on the tail produced a 400 on the second follow-up.
    for (const opts of [{}, { history }, { history, userTurnOverride: "repair prompt" }]) {
      const ttls = ttlsInOrder(buildPromptBlocks(request, opts));
      for (let i = 1; i < ttls.length; i += 1) {
        expect(RANK[ttls[i] as string]).toBeLessThanOrEqual(RANK[ttls[i - 1] as string] as number);
      }
    }
  });

  it("never exceeds the four-breakpoint limit", () => {
    expect(ttlsInOrder(buildPromptBlocks(request, { history })).length).toBeLessThanOrEqual(4);
  });

  it("replays history as alternating user/assistant turns, newest last", () => {
    // The assistant turns are the stored recipe JSON, fed back verbatim —
    // paraphrasing would change the prefix bytes and cost the cache.
    const { messages } = buildPromptBlocks(request, { history });
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(messages[1]?.content).toBe('{"title":"Pasta"}');
  });

  it("keeps the repair prompt after the breakpoint, never in the system block", () => {
    const { system, messages } = buildPromptBlocks(request, {
      userTurnOverride: "the verifier found these problems…",
    });
    expect(system[0]?.text).not.toContain("verifier found");
    expect(messages[0]?.content).toContain("verifier found");
  });
});
