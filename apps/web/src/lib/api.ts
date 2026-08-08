import type { Equipment, Feedback, Stats } from "@cookable/shared";
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

export async function fetchPantry(): Promise<PantryState> {
  const res = await fetch("/api/pantry", { headers: await authHeaders() });
  if (!res.ok) throw new Error(`Failed to load pantry (${res.status})`);
  return (await res.json()) as PantryState;
}

export async function savePantry(patch: Partial<PantryState>): Promise<PantryState> {
  const res = await fetch("/api/pantry", {
    method: "PUT",
    headers: await authHeaders(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to save pantry (${res.status})`);
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
