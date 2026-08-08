import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase handles Google OAuth only. All app data lives in our own API.
 *
 * If the env vars are absent we return null and the app runs in local mode
 * against an API with DEV_ALLOW_ANONYMOUS=1 — so you can build the whole UI
 * before setting up an OAuth consent screen.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && anonKey ? createClient(url, anonKey) : null;

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
