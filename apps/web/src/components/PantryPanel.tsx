import { useEffect, useState } from "react";
import { Refrigerator, Save, Loader2, Cookie } from "lucide-react";
import clsx from "clsx";
import { APPLIANCES, type Equipment } from "@cookable/shared";
import { fetchPantry, savePantry, type PantryState } from "../lib/api";

/**
 * The pantry and cookware are the evidence recipes get grounded against, so
 * they live server-side and are read on every generation — the user shouldn't
 * have to re-state their kitchen each time they ask a question.
 *
 * Cookware is a fixed checklist rather than free text on purpose: it shares a
 * closed vocabulary with the recipe schema's equipment enum, so verification
 * is exact set membership instead of fuzzy string matching.
 */
export function PantryPanel() {
  const [state, setState] = useState<PantryState>({
    pantry: [],
    dislikes: [],
    dietary: [],
    cookware: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchPantry()
      .then(setState)
      .catch(() => void 0)
      .finally(() => setLoading(false));
  }, []);

  function update(patch: Partial<PantryState>) {
    setState((s) => ({ ...s, ...patch }));
    setSaved(false);
  }

  function toggleCookware(item: Equipment) {
    update({
      cookware: state.cookware.includes(item)
        ? state.cookware.filter((c) => c !== item)
        : [...state.cookware, item],
    });
  }

  async function persist() {
    setSaving(true);
    try {
      setState(await savePantry(state));
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const toLines = (items: string[]) => items.join("\n");
  const fromLines = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <aside className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Refrigerator className="h-4 w-4" />
          Your kitchen
        </h2>

        <label className="mt-4 block text-sm font-medium text-slate-700">
          What you have
          <textarea
            value={toLines(state.pantry)}
            onChange={(e) => update({ pantry: fromLines(e.target.value) })}
            rows={8}
            placeholder={"chicken thighs\nonion\nrice\nsoy sauce"}
            className="mt-1.5 w-full rounded-lg border border-slate-200 p-2 font-normal text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none"
          />
          <span className="text-xs font-normal text-slate-400">One item per line.</span>
        </label>

        <label className="mt-4 block text-sm font-medium text-slate-700">
          Never suggest
          <textarea
            value={toLines(state.dislikes)}
            onChange={(e) => update({ dislikes: fromLines(e.target.value) })}
            rows={3}
            placeholder={"coriander\nolives"}
            className="mt-1.5 w-full rounded-lg border border-slate-200 p-2 font-normal text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none"
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-slate-700">
          Dietary
          <textarea
            value={toLines(state.dietary)}
            onChange={(e) => update({ dietary: fromLines(e.target.value) })}
            rows={2}
            placeholder={"vegetarian"}
            className="mt-1.5 w-full rounded-lg border border-slate-200 p-2 font-normal text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none"
          />
          <span className="text-xs font-normal text-slate-400">
            vegetarian · vegan · dairy-free · gluten-free · pescatarian
          </span>
        </label>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          <Cookie className="h-4 w-4" />
          What you can cook with
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Knives, pans and bowls are assumed. Tick the appliances you actually own — no air fryer
          means no air fryer recipes.
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {APPLIANCES.map((item) => {
            const on = state.cookware.includes(item);
            return (
              <button
                key={item}
                type="button"
                onClick={() => toggleCookware(item)}
                aria-pressed={on}
                className={clsx(
                  "rounded-full px-3 py-1 text-sm capitalize transition",
                  on
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200",
                )}
              >
                {item}
              </button>
            );
          })}
        </div>

        {state.cookware.length === 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
            Nothing ticked — recipes will use hand tools only, which is very limiting. Tick at least
            your stovetop or oven.
          </p>
        )}
      </section>

      <button
        onClick={persist}
        disabled={saving}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900 disabled:bg-slate-300"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {saved && !saving ? "Saved" : "Save kitchen"}
      </button>
    </aside>
  );
}
