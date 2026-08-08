import { ArrowRight } from "lucide-react";
import { signInWithGoogle } from "../lib/supabase";

/** Google's mark, inlined so the page has no external asset dependency. */
function GoogleIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.47 14.97.5 12 .5A11 11 0 0 0 2.18 7.05l3.66 2.84c.87-2.6 3.3-4.14 6.16-4.14Z"
      />
    </svg>
  );
}

export function Landing() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-20 text-center">
      <h1 className="text-5xl font-bold tracking-tight text-brand-800 sm:text-6xl">
        Recipes you can
        <br />
        actually make tonight
      </h1>

      <p className="mx-auto mt-6 max-w-xl text-lg text-slate-600">
        Tell it what you're craving and what's in your kitchen. Every suggestion is checked against
        your actual ingredients and your actual time before you see it — so you never get a recipe
        that needs four things you don't have.
      </p>

      <button
        onClick={() => void signInWithGoogle()}
        className="mx-auto mt-10 inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-6 py-3.5 font-medium text-slate-800 shadow-sm transition hover:border-slate-300 hover:shadow"
      >
        <GoogleIcon />
        Sign in with Google
        <ArrowRight className="h-4 w-4 text-slate-400" />
      </button>

      <dl className="mx-auto mt-20 grid max-w-2xl gap-8 text-left sm:grid-cols-3">
        {[
          {
            term: "Grounded",
            desc: "Every ingredient is tagged as something you have, a staple, or something to buy — and we recompute that ourselves rather than trusting the model.",
          },
          {
            term: "Time-honest",
            desc: "If you say 20 minutes, the recipe is checked against 20 minutes. Steps that don't add up get flagged.",
          },
          {
            term: "Learns you",
            desc: "Dislikes and dietary needs are remembered, so you stop repeating yourself.",
          },
        ].map(({ term, desc }) => (
          <div key={term}>
            <dt className="font-semibold text-slate-900">{term}</dt>
            <dd className="mt-1 text-sm text-slate-600">{desc}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
