import type { Equipment, Feedback, Stats } from "@cookmate/shared";
import { getAccessToken } from "./supabase";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export interface PantryState {
  pantry: string[];
  dislikes: string[];
  dietary: string[];
  cookware: Equipment[];
}

/**
 * Turn a failed response into a message a person can act on.
 *
 * "Failed to save pantry (400)" tells the user nothing and tells you nothing —
 * the server already sends field-level Zod issues, so surface the first one.
 * A silent or opaque failure on this endpoint is expensive: the pantry is the
 * evidence every recipe is verified against, so a save that quietly doesn't
 * happen means every later generation runs against nothing.
 */
async function failure(res: Response, action: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await res.json()) as {
      error?: string;
      issues?: Array<{ path?: unknown; message?: string }>;
    };
    const first = body.issues?.[0];
    if (first?.message) {
      const path = Array.isArray(first.path) ? first.path : [];
      const field = typeof path[0] === "string" ? path[0] : "";
      const index = typeof path[1] === "number" ? ` item ${path[1] + 1}` : "";
      detail = field ? `${field}${index} — ${first.message}` : first.message;
    } else if (body.error) {
      detail = body.error;
    }
  } catch {
    // Non-JSON body; fall back to the status code below.
  }
  return new Error(detail ? `Couldn't ${action}: ${detail}` : `Couldn't ${action} (${res.status})`);
}

export async function fetchPantry(): Promise<PantryState> {
  const res = await fetch("/api/pantry", { headers: await authHeaders() });
  if (!res.ok) throw await failure(res, "load your kitchen");
  return (await res.json()) as PantryState;
}

export async function savePantry(patch: Partial<PantryState>): Promise<PantryState> {
  const res = await fetch("/api/pantry", {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await failure(res, "save your kitchen");
  return (await res.json()) as PantryState;
}

export async function sendFeedback(feedback: Partial<Feedback> & { turnId: string }): Promise<void> {
  await fetch("/api/feedback", {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(feedback),
  });
}

export async function fetchStats(): Promise<Stats> {
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error(`Failed to load stats (${res.status})`);
  return (await res.json()) as Stats;
}

export { authHeaders };
