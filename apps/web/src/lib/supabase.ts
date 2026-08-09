import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase handles Google OAuth only. All app data lives in our own API.
 *
 * If the env vars are absent we return null and the app runs in local mode
 * against an API with DEV_ALLOW_ANONYMOUS=1 — so you can build the whole UI
 * before setting up an OAuth consent screen.
 */
/**
 * Copying .env.example verbatim leaves `<project-ref>` placeholders behind.
 * Those are truthy, so a naive presence check would flip auth *on* with a
 * bogus client and strand the user on the sign-in screen with a dead button.
 * Treat anything unusable as unconfigured, so the documented "cp the example"
 * path lands in local mode rather than a broken half-configured one.
 */
function configured(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed !== "" && !trimmed.includes("<") && !trimmed.includes(">");
}

function usableUrl(value: string | undefined): value is string {
  if (!configured(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  usableUrl(url) && configured(anonKey) ? createClient(url, anonKey) : null;

export const authEnabled = supabase !== null;

export async function signInWithGoogle(): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured");
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
