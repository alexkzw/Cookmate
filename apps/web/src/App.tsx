import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, authEnabled, signOut } from "./lib/supabase";
import { Landing } from "./components/Landing";
import { Chat } from "./components/Chat";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!authEnabled);
  // The usage strip is dev-only noise for the end user, but it's the thing you
  // most want visible while building. Toggle with ?debug=1.
  const showUsage = new URLSearchParams(window.location.search).has("debug") || import.meta.env.DEV;

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return null;

  // With Supabase unconfigured the app runs against a dev API that bypasses
  // auth, so the whole UI is buildable before the OAuth consent screen exists.
  const signedIn = !authEnabled || session !== null;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-bold tracking-tight text-brand-700">cookmate</span>
            {!authEnabled && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-800">
                local
              </span>
            )}
          </div>
          {signedIn && authEnabled && (
            <button
              onClick={() => void signOut()}
              className="text-sm text-slate-500 transition hover:text-slate-800"
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      {signedIn ? <Chat showUsage={showUsage} /> : <Landing />}
    </div>
  );
}
