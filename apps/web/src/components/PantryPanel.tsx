import { useEffect, useState } from "react";
import { Refrigerator, Save, Loader2 } from "lucide-react";
import { fetchPantry, savePantry, type PantryState } from "../lib/api";

/**
 * The pantry is the evidence the recipe gets grounded against, so it lives
 * server-side and is loaded on every generation — the user shouldn't have to
 * re-state their kitchen each time they ask a question.
 */
export function PantryPanel() {
  const [state, setState] = useState<PantryState>({ pantry: [], dislikes: [], dietary: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    fetchPantry()
      .then(setState)
      .catch(() => void 0)
      .finally(() => setLoading(false));
  }, []);

  async function persist() {
    setSaving(true);
    try {
      setState(await savePantry(state));
      setSavedAt(Date.now());
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
      <div className="rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <aside className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
        <Refrigerator className="h-4 w-4" />
        Your kitchen
      </h2>

      <label className="mt-4 block text-sm font-medium text-slate-700">
        What you have
        <textarea
          value={toLines(state.pantry)}
          onChange={(e) => setState({ ...state, pantry: fromLines(e.target.value) })}
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
          onChange={(e) => setState({ ...state, dislikes: fromLines(e.target.value) })}
          rows={3}
          placeholder={"coriander\nolives"}
          className="mt-1.5 w-full rounded-lg border border-slate-200 p-2 font-normal text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none"
        />
      </label>

      <label className="mt-4 block text-sm font-medium text-slate-700">
        Dietary
        <textarea
          value={toLines(state.dietary)}
          onChange={(e) => setState({ ...state, dietary: fromLines(e.target.value) })}
          rows={2}
          placeholder={"vegetarian"}
          className="mt-1.5 w-full rounded-lg border border-slate-200 p-2 font-normal text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none"
        />
        <span className="text-xs font-normal text-slate-400">
          vegetarian · vegan · dairy-free · gluten-free · pescatarian
        </span>
      </label>

      <button
        onClick={persist}
        disabled={saving}
        className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-900 disabled:bg-slate-300"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {savedAt && !saving ? "Saved" : "Save kitchen"}
      </button>
    </aside>
  );
}
