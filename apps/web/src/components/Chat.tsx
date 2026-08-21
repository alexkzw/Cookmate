import { useState } from "react";
import { AlertCircle, Sparkles, Square, CornerDownLeft } from "lucide-react";
import { useRecipeStream, type CookRequestInput } from "../hooks/useRecipeStream";
import { CookForm } from "./CookForm";
import { RecipeCard } from "./RecipeCard";
import { VerificationBadge } from "./VerificationBadge";
import { UsageBar } from "./UsageBar";
import { PantryPanel } from "./PantryPanel";

export function Chat({ showUsage }: { showUsage: boolean }) {
  const { state, start, cancel } = useRecipeStream();
  const [followUp, setFollowUp] = useState("");
  const [lastRequest, setLastRequest] = useState<CookRequestInput | null>(null);

  const busy =
    state.phase === "generating" ||
    state.phase === "repairing" ||
    state.phase === "verifying";
  const hasResult = state.recipe !== null;

  function onSubmit(req: CookRequestInput) {
    setLastRequest(req);
    setFollowUp("");
    void start(req);
  }

  /**
   * Continue the conversation.
   *
   * The servings, time budget and effort carry over from the original ask —
   * "make it faster" shouldn't silently reset them — and `followUpTo` chains
   * this turn to the last one so the server can replay the history.
   */
  function sendFollowUp() {
    const text = followUp.trim();
    if (!text || !lastRequest || !state.turnId) return;
    void start({ ...lastRequest, craving: text, followUpTo: state.turnId });
    setFollowUp("");
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <CookForm onSubmit={onSubmit} busy={busy} compact={hasResult} />

        {busy && (
          <button
            type="button"
            onClick={cancel}
            className="flex items-center gap-2 rounded-full bg-slate-100 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-200"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
            Stop
          </button>
        )}

        {state.phase === "error" && (
          <div className="flex items-start gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-800 ring-1 ring-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{state.error}</p>
          </div>
        )}

        {/* Streaming preview: the model is emitting JSON, so we show the fields
            we can scrape as they arrive rather than raw tokens. */}
        {state.phase === "generating" && !state.recipe && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <Sparkles className="h-4 w-4 animate-shimmer" />
              Thinking about what fits…
            </div>
            {state.preview.title && (
              <h2 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">
                {state.preview.title}
              </h2>
            )}
            {state.preview.summary && (
              <p className="mt-1 text-slate-600">{state.preview.summary}</p>
            )}
            {state.preview.ingredientCount > 0 && (
              <p className="mt-3 text-sm text-slate-400">
                {state.preview.ingredientCount} ingredient
                {state.preview.ingredientCount === 1 ? "" : "s"} so far…
              </p>
            )}
          </div>
        )}

        {state.phase === "repairing" && state.repairing && (
          <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
            <p className="flex items-center gap-2 font-medium">
              <Sparkles className="h-4 w-4 animate-shimmer" />
              That one didn't check out — asking for a fix…
            </p>
            <ul className="mt-2 space-y-1 pl-1">
              {state.repairing.map((issue, i) => (
                <li key={i}>· {issue}</li>
              ))}
            </ul>
          </div>
        )}

        {(busy || state.verification) && hasResult && (
          <VerificationBadge verification={state.verification} phase={state.phase} />
        )}

        {state.recipe && (
          <RecipeCard
            recipe={state.recipe}
            verification={state.verification}
            turnId={state.turnId}
          />
        )}

        {hasResult && !busy && state.turnId && (
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <label
              htmlFor="followup"
              className="text-sm font-medium text-slate-700"
            >
              Adjust this recipe
            </label>
            <p className="mt-0.5 text-xs text-slate-400">
              "Make it faster", "swap the chicken", "I don't have an oven after all". You'll get a
              new recipe, checked against your kitchen the same way.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                id="followup"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendFollowUp();
                  }
                }}
                placeholder="What would you change?"
                className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
              <button
                type="button"
                onClick={sendFollowUp}
                disabled={followUp.trim().length === 0}
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-40"
              >
                <CornerDownLeft className="h-3.5 w-3.5" />
                Send
              </button>
            </div>
          </div>
        )}

        {showUsage && state.usage && <UsageBar usage={state.usage} />}
      </div>

      <PantryPanel />
    </main>
  );
}
