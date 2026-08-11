import { useEffect, useState } from "react";
import { Refrigerator, Save, Loader2, Cookie, AlertCircle } from "lucide-react";
import clsx from "clsx";
import { APPLIANCES, type Equipment } from "@cookmate/shared";
import { fetchPantry, savePantry } from "../lib/api";

/**
 * The pantry and cookware are the evidence recipes get grounded against, so
 * they live server-side and are read on every generation — the user shouldn't
 * have to re-state their kitchen each time they ask a question.
 *
 * Cookware is a fixed checklist rather than free text on purpose: it shares a
 * closed vocabulary with the recipe schema's equipment enum, so verification
 * is exact set membership instead of fuzzy string matching.
 *
 * TEXT IS HELD RAW AND PARSED ONCE, ON SAVE.
 *
 * The previous version parsed on every keystroke and rendered the result back
 * into the textarea. A trailing space was therefore trimmed away before the
 * next character could arrive — you could not type "soy sauce" — and Enter was
 * eaten the same way by the empty-line filter, so the box could only ever hold
 * one item. Intermediate typing states are not valid final states, so
 * normalising a controlled input on every change is always wrong. Keep the raw
 * string; parse at the boundary where it actually matters.
 */

/** One item per line. Commas too, so a pasted "a, b, c" list also works. */
function toItems(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const toText = (items: string[]) => items.join("\n");

type TextField = "pantry" | "dislikes" | "dietary";

export function PantryPanel() {
  const [text, setText] = useState<Record<TextField, string>>({
    pantry: "",
    dislikes: "",
    dietary: "",
  });
  const [cookware, setCookware] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPantry()
      .then((stored) => {
        setText({
          pantry: toText(stored.pantry),
          dislikes: toText(stored.dislikes),
          dietary: toText(stored.dietary),
        });
        setCookware(stored.cookware);
      })
      .catch(() => setError("Couldn't load your kitchen — is the API running?"))
      .finally(() => setLoading(false));
  }, []);

  function edit(field: TextField, value: string) {
    setText((current) => ({ ...current, [field]: value }));
    setSaved(false);
    setError(null);
  }

  function toggleCookware(item: Equipment) {
    setCookware((current) =>
      current.includes(item) ? current.filter((c) => c !== item) : [...current, item],
    );
    setSaved(false);
    setError(null);
  }

  async function persist() {
    setSaving(true);
    setError(null);
    try {
      const next = await savePantry({
        pantry: toItems(text.pantry),
        dislikes: toItems(text.dislikes),
        dietary: toItems(text.dietary),
        cookware,
      });
      // Re-render from what the server actually stored, so the box always shows
      // the evidence the verifier will really use — not what you hoped it saved.
      setText({
        pantry: toText(next.pantry),
        dislikes: toText(next.dislikes),
        dietary: toText(next.dietary),
      });
      setCookware(next.cookware);
      setSaved(true);
    } catch (err) {
      // A rejected save used to disappear into an unhandled promise: the button
      // returned to "Save kitchen" and the pantry stayed empty, so every recipe
      // was silently generated against no evidence at all. Never swallow this.
      setError(err instanceof Error ? err.message : "Couldn't save your kitchen.");
    } finally {
      setSaving(false);
    }
  }

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
            value={text.pantry}
            onChange={(e) => edit("pantry", e.target.value)}
            rows={8}
            placeholder={"chicken thighs\nonion\nrice\nsoy sauce"}
            className="mt-1.5 w-full rounded-lg border border-slate-200 p-2 font-normal text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none"
          />
          <span className="text-xs font-normal text-slate-400">
            One item per line. Commas work too.
          </span>
        </label>

        <label className="mt-4 block text-sm font-medium text-slate-700">
          Never suggest
          <textarea
            value={text.dislikes}
            onChange={(e) => edit("dislikes", e.target.value)}
            rows={3}
            placeholder={"coriander\nolives"}
            className="mt-1.5 w-full rounded-lg border border-slate-200 p-2 font-normal text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none"
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-slate-700">
          Dietary
          <textarea
            value={text.dietary}
            onChange={(e) => edit("dietary", e.target.value)}
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
            const on = cookware.includes(item);
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

        {cookware.length === 0 && (
          <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-900 ring-1 ring-amber-200">
            Nothing ticked — recipes will use hand tools only, which is very limiting. Tick at least
            your stovetop or oven.
          </p>
        )}
      </section>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        onClick={() => void persist()}
        disabled={saving}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-900 disabled:bg-slate-300"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {saved && !saving ? "Saved" : "Save kitchen"}
      </button>
    </aside>
  );
}
