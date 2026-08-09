import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import type { Verification } from "@cookmate/shared";
import type { Phase } from "../hooks/useRecipeStream";

/**
 * The product claim, rendered.
 *
 * It resolves a beat after the recipe because the check genuinely runs after
 * generation. Showing "Checking…" and then a verdict is honest about the
 * architecture, and it's the moment the app earns its trust.
 */
export function VerificationBadge({
  verification,
  phase,
}: {
  verification: Verification | null;
  phase: Phase;
}) {
  if (phase === "verifying" || (phase === "generating" && !verification)) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking against your kitchen…
      </div>
    );
  }

  if (!verification) return null;

  if (verification.ok) {
    return (
      <div className="inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-800 ring-1 ring-brand-200">
        <CheckCircle2 className="h-4 w-4" />
        You can make this — {verification.pantryUsedCount} from your kitchen,{" "}
        {verification.totalMinutes} min
        {verification.passiveMinutes > 0 && (
          <span className="font-normal">({verification.activeMinutes} hands-on)</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 ring-1 ring-amber-200">
        <AlertTriangle className="h-4 w-4" />
        {verification.violations.length} thing
        {verification.violations.length === 1 ? "" : "s"} to know
      </div>
      <ul className="space-y-1 pl-1 text-sm text-amber-900">
        {verification.violations.map((v, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="select-none text-amber-500">
              •
            </span>
            <span>{v.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
