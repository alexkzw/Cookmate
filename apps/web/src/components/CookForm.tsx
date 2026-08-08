import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import clsx from "clsx";
import { EFFORT_LEVELS, type CookRequest } from "@cookable/shared";

/** What the client is allowed to choose. The rest is server-owned state. */
export type CookFormValues = Omit<
  CookRequest,
  "pantry" | "dislikes" | "dietary" | "cookware"
>;

const TIME_PRESETS = [15, 30, 45, 90] as const;

/**
 * The composer. Modelled on the reference screenshot: one prompt line plus the
 * few structured knobs that materially change the answer.
 *
 * These are separate fields rather than free text because the verifier needs
 * them as numbers — "quick-ish" can't be checked, "30 minutes" can.
 */
export function CookForm({
  onSubmit,
  busy,
  compact = false,
}: {
  onSubmit: (req: CookFormValues) => void;
  busy: boolean;
  compact?: boolean;
}) {
  const [craving, setCraving] = useState("");
  const [servings, setServings] = useState(2);
  const [maxMinutes, setMaxMinutes] = useState(30);
  const [effort, setEffort] = useState<CookRequest["effort"]>("moderate");
  const [willShop, setWillShop] = useState(true);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!craving.trim() || busy) return;
    // Pantry, dislikes and dietary are deliberately NOT sent: the server owns
    // them and reads its stored copy. Sending empty arrays here would override
    // the real pantry with nothing.
    onSubmit({ craving: craving.trim(), servings, maxMinutes, effort, willShop });
  }

  return (
    <form
      onSubmit={submit}
      className={clsx(
        "rounded-2xl border border-slate-200 bg-white shadow-sm",
        compact ? "p-4" : "p-6",
      )}
    >
      <textarea
        value={craving}
        onChange={(e) => setCraving(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) submit(e);
        }}
        placeholder="What are you in the mood for? e.g. something spicy with noodles, or use up the eggplant…"
        rows={compact ? 2 : 3}
        className="w-full resize-none border-0 p-0 text-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-0"
      />

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-slate-100 pt-4">
        <label className="flex items-center gap-2 text-sm text-slate-600">
          for
          <input
            type="number"
            min={1}
            max={12}
            value={servings}
            onChange={(e) => setServings(Number(e.target.value))}
            className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-center tabular-nums focus:border-brand-500 focus:outline-none"
          />
          people
        </label>

        <div className="flex items-center gap-1.5">
          <span className="text-sm text-slate-600">in</span>
          {TIME_PRESETS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setMaxMinutes(t)}
              className={clsx(
                "rounded-lg px-2.5 py-1 text-sm transition",
                maxMinutes === t
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {t}m
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          {EFFORT_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => setEffort(level)}
              className={clsx(
                "rounded-lg px-2.5 py-1 text-sm capitalize transition",
                effort === level
                  ? "bg-slate-800 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {level}
            </button>
          ))}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={willShop}
            onChange={(e) => setWillShop(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          I can pop to the shop
        </label>

        <button
          type="submit"
          disabled={busy || !craving.trim()}
          className="ml-auto inline-flex items-center gap-2 rounded-lg bg-brand-600 px-5 py-2 font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy ? "Cooking up…" : "Find me something"}
        </button>
      </div>
    </form>
  );
}
