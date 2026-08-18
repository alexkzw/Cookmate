import { useCallback, useRef, useState } from "react";
import {
  StreamEventSchema,
  type CookRequest,
  type Recipe,
  type StreamEvent,
  type Verification,
} from "@cookmate/shared";
import { authHeaders } from "../lib/api";

/** The client picks these; pantry/prefs/cookware are read server-side. */
export type CookRequestInput = Omit<
  CookRequest,
  "pantry" | "dislikes" | "dietary" | "cookware"
>;

/**
 * Consumes the SSE stream from POST /api/chat/stream.
 *
 * Note we can't use EventSource: it only does GET, and the cook request is a
 * body. So this is fetch + a manual SSE frame parser over the response's
 * ReadableStream — about twenty lines, and it gives us abort support for free.
 */

export type Phase = "idle" | "generating" | "repairing" | "verifying" | "done" | "error";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cacheStatus: "HIT" | "MISS" | "PARTIAL" | "NONE";
  model: string;
  latencyMs: number;
}

export interface StreamState {
  phase: Phase;
  turnId: string | null;
  /** Progressive preview scraped from the streaming JSON. */
  preview: { title: string | null; summary: string | null; ingredientCount: number };
  recipe: Recipe | null;
  verification: Verification | null;
  /**
   * Problems the verifier found on the first attempt, while the model is being
   * asked to fix them. Surfaced rather than hidden: the retry is part of what
   * the product does, and pretending the first answer never happened would be
   * the same dishonesty as hiding the verification step.
   */
  repairing: string[] | null;
  usage: Usage | null;
  error: string | null;
}

const EMPTY: StreamState = {
  phase: "idle",
  turnId: null,
  preview: { title: null, summary: null, ingredientCount: 0 },
  recipe: null,
  verification: null,
  repairing: null,
  usage: null,
  error: null,
};

/**
 * Because structured outputs make the model emit JSON rather than prose, the
 * raw deltas aren't readable. Rather than ship a full partial-JSON parser for
 * v1, we scrape the two fields that appear first and count ingredient objects
 * as they land. Cheap, and it makes the wait feel like progress.
 */
function scrapePreview(buffer: string): StreamState["preview"] {
  const title = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buffer)?.[1] ?? null;
  const summary = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buffer)?.[1] ?? null;
  const ingredientCount = (buffer.match(/"source"\s*:\s*"/g) ?? []).length;
  return {
    title: title ? title.replace(/\\"/g, '"') : null,
    summary: summary ? summary.replace(/\\"/g, '"') : null,
    ingredientCount,
  };
}

export function useRecipeStream() {
  const [state, setState] = useState<StreamState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(EMPTY);
  }, []);

  const start = useCallback(async (request: CookRequestInput) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ ...EMPTY, phase: "generating" });
    let jsonBuffer = "";

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: await authHeaders(),
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Request failed (${res.status})`);
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let frameBuffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        frameBuffer += value;

        // SSE frames are separated by a blank line.
        const frames = frameBuffer.split("\n\n");
        frameBuffer = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLine = frame
            .split("\n")
            .find((l) => l.startsWith("data:"));
          if (!dataLine) continue;

          let event: StreamEvent;
          try {
            event = StreamEventSchema.parse(JSON.parse(dataLine.slice(5).trim()));
          } catch {
            continue; // ignore heartbeats / malformed frames
          }

          switch (event.type) {
            case "start":
              setState((s) => ({ ...s, turnId: event.turnId }));
              break;
            case "delta":
              jsonBuffer += event.text;
              setState((s) => ({ ...s, preview: scrapePreview(jsonBuffer) }));
              break;
            case "repairing":
              setState((s) => ({ ...s, phase: "repairing", repairing: event.issues }));
              break;
            case "recipe":
              setState((s) => ({ ...s, recipe: event.recipe, phase: "verifying", repairing: null }));
              break;
            case "verification":
              setState((s) => ({ ...s, verification: event.verification }));
              break;
            case "done":
              setState((s) => ({ ...s, usage: event.usage, phase: "done" }));
              break;
            case "error":
              setState((s) => ({ ...s, error: event.message, phase: "error" }));
              break;
          }
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      setState((s) => ({
        ...s,
        phase: "error",
        error: err instanceof Error ? err.message : "Something went wrong.",
      }));
    }
  }, []);

  return { state, start, reset };
}
