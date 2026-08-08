import { useState } from "react";
import { Clock, Users, ChefHat, ShoppingCart, ThumbsUp, ThumbsDown, Check } from "lucide-react";
import clsx from "clsx";
import type { Recipe, Verification } from "@cookable/shared";
import { sendFeedback } from "../lib/api";

const SOURCE_STYLES: Record<string, string> = {
  pantry: "bg-brand-50 text-brand-800 ring-brand-200",
  staple: "bg-slate-100 text-slate-600 ring-slate-200",
  shopping: "bg-amber-50 text-amber-900 ring-amber-200",
};

const SOURCE_LABEL: Record<string, string> = {
  pantry: "have it",
  staple: "staple",
  shopping: "buy",
};

export function RecipeCard({
  recipe,
  verification,
  turnId,
}: {
  recipe: Recipe;
  verification: Verification | null;
  turnId: string | null;
}) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [cooked, setCooked] = useState(false);

  /**
   * Feedback fires and forgets. Two signals: a cheap rating, and the one that
   * actually matters — did they cook it. That second number is what makes the
   * usage story credible later.
   */
  function rate(next: "up" | "down") {
    setRating(next);
    if (turnId) void sendFeedback({ turnId, rating: next });
  }

  function markCooked() {
    setCooked(true);
    if (turnId) void sendFeedback({ turnId, cooked: true });
  }

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-100 px-6 py-5">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">{recipe.title}</h2>
        <p className="mt-1 text-slate-600">{recipe.summary}</p>

        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-4 w-4 text-slate-400" />
            {recipe.prepMinutes + recipe.cookMinutes} min
            <span className="text-slate-400">
              ({recipe.prepMinutes} prep · {recipe.cookMinutes} cook)
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-4 w-4 text-slate-400" />
            Serves {recipe.servings}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ChefHat className="h-4 w-4 text-slate-400" />
            {recipe.difficulty}
          </span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{recipe.cuisine}</span>
        </div>
      </header>

      <div className="grid gap-6 px-6 py-5 md:grid-cols-[minmax(0,320px)_1fr]">
        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Ingredients
          </h3>
          <ul className="space-y-2">
            {recipe.ingredients.map((ing, i) => (
              <li key={i} className="flex items-start justify-between gap-3 text-sm">
                <span className="text-slate-800">
                  <span className="tabular-nums text-slate-500">
                    {ing.unit === "to_taste" ? "" : `${ing.quantity} `}
                    {ing.unit === "to_taste" ? "" : `${ing.unit} `}
                  </span>
                  {ing.name}
                  {ing.substitute && (
                    <span className="block text-xs text-slate-400">or {ing.substitute}</span>
                  )}
                </span>
                <span
                  className={clsx(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs ring-1",
                    SOURCE_STYLES[ing.source] ?? SOURCE_STYLES.staple,
                  )}
                >
                  {SOURCE_LABEL[ing.source] ?? ing.source}
                </span>
              </li>
            ))}
          </ul>

          {verification && verification.shoppingList.length > 0 && (
            <div className="mt-5 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-200">
              <h4 className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
                <ShoppingCart className="h-4 w-4" />
                Shopping list ({verification.shoppingList.length})
              </h4>
              <ul className="mt-2 space-y-1 text-sm text-amber-900">
                {verification.shoppingList.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Method
          </h3>
          <ol className="space-y-4">
            {recipe.steps.map((step) => (
              <li key={step.number} className="flex gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
                  {step.number}
                </span>
                <div className="pt-0.5">
                  <p className="text-slate-800">{step.instruction}</p>
                  <p className="mt-0.5 text-xs text-slate-400">{step.minutes} min</p>
                </div>
              </li>
            ))}
          </ol>

          {recipe.tips.length > 0 && (
            <div className="mt-5 rounded-xl bg-slate-50 p-4">
              <h4 className="text-sm font-semibold text-slate-700">Tips</h4>
              <ul className="mt-2 space-y-1 text-sm text-slate-600">
                {recipe.tips.map((tip, i) => (
                  <li key={i}>· {tip}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-6 py-4">
        <button
          onClick={markCooked}
          disabled={cooked}
          className={clsx(
            "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition",
            cooked
              ? "bg-brand-100 text-brand-800"
              : "bg-brand-600 text-white hover:bg-brand-700",
          )}
        >
          <Check className="h-4 w-4" />
          {cooked ? "Marked as cooked" : "I cooked this"}
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={() => rate("up")}
            aria-label="Good suggestion"
            className={clsx(
              "rounded-lg p-2 transition",
              rating === "up"
                ? "bg-brand-100 text-brand-700"
                : "text-slate-400 hover:bg-slate-200 hover:text-slate-600",
            )}
          >
            <ThumbsUp className="h-4 w-4" />
          </button>
          <button
            onClick={() => rate("down")}
            aria-label="Bad suggestion"
            className={clsx(
              "rounded-lg p-2 transition",
              rating === "down"
                ? "bg-red-100 text-red-700"
                : "text-slate-400 hover:bg-slate-200 hover:text-slate-600",
            )}
          >
            <ThumbsDown className="h-4 w-4" />
          </button>
        </div>
      </footer>
    </article>
  );
}
