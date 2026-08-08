import { AlertCircle, Sparkles } from "lucide-react";
import type { CookRequest } from "@cookable/shared";
import { useRecipeStream } from "../hooks/useRecipeStream";
import { CookForm } from "./CookForm";
import { RecipeCard } from "./RecipeCard";
import { VerificationBadge } from "./VerificationBadge";
import { UsageBar } from "./UsageBar";
import { PantryPanel } from "./PantryPanel";

export function Chat({ showUsage }: { showUsage: boolean }) {
  const { state, start } = useRecipeStream();
  const busy = state.phase === "generating" || state.phase === "verifying";
  const hasResult = state.recipe !== null;

  function onSubmit(req: CookRequest) {
    void start(req);
  }

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <CookForm onSubmit={onSubmit} busy={busy} compact={hasResult} />

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

        {showUsage && state.usage && <UsageBar usage={state.usage} />}
      </div>

      <PantryPanel />
    </main>
  );
}
