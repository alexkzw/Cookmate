import clsx from "clsx";
import type { Usage } from "../hooks/useRecipeStream";

const CACHE_STYLES: Record<Usage["cacheStatus"], string> = {
  HIT: "bg-brand-100 text-brand-800",
  PARTIAL: "bg-sky-100 text-sky-800",
  MISS: "bg-amber-100 text-amber-800",
  NONE: "bg-slate-100 text-slate-600",
};

/**
 * The debug strip. Kept visible on purpose during development: prompt caching
 * fails silently — you only find out it isn't working by watching this number,
 * never by reading the code that sets cache_control.
 */
export function UsageBar({ usage }: { usage: Usage }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-500">
      <span className="font-medium text-slate-700">{usage.model}</span>
      <span className={clsx("rounded px-1.5 py-0.5 font-medium", CACHE_STYLES[usage.cacheStatus])}>
        cache {usage.cacheStatus}
      </span>
      <span>
        in {usage.inputTokens.toLocaleString()} · out {usage.outputTokens.toLocaleString()}
      </span>
      {usage.cacheReadTokens > 0 && <span>cached-read {usage.cacheReadTokens.toLocaleString()}</span>}
      {usage.cacheWriteTokens > 0 && (
        <span>cached-write {usage.cacheWriteTokens.toLocaleString()}</span>
      )}
      <span>${usage.costUsd.toFixed(4)}</span>
      <span>{(usage.latencyMs / 1000).toFixed(1)}s</span>
    </div>
  );
}
