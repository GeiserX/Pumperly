"use client";

import { useI18n } from "@/lib/i18n";

/** State of the no-route (bounding box) station fetch, as shown on the map. */
export type MapStationsStatus = "idle" | "loading" | "error" | "empty";

interface MapStatusProps {
  status: MapStationsStatus;
  onRetry: () => void;
}

// rounded-2xl, not rounded-full: on a narrow phone the text wraps to two
// lines, and a full radius would clip its corners and the Retry button.
const PILL_CLASS =
  "flex items-center gap-3 rounded-2xl border border-black/10 bg-white/90 px-4 py-2 text-sm font-medium text-gray-800 shadow-md backdrop-blur-md dark:border-white/10 dark:bg-gray-900/90 dark:text-gray-100";

/**
 * A card that says when the stations are loading, failed to load, or none sell
 * this fuel here. Without it each of those looked the same as a bare street
 * map. MapView places it at the bottom of the map, above the price legend,
 * where the search card, its lists and its toasts never cover it.
 */
export function MapStatus({ status, onRetry }: MapStatusProps) {
  const { t } = useI18n();
  if (status === "idle") return null;

  return status === "error" ? (
    <div role="alert" className={PILL_CLASS}>
      <span className="min-w-0">{t("map.loadError")}</span>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 rounded-full bg-emerald-500 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
      >
        {t("common.retry")}
      </button>
    </div>
  ) : (
    <div role="status" aria-live="polite" className={PILL_CLASS}>
      {status === "loading" && (
        <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      )}
      <span className="min-w-0">{status === "loading" ? t("map.loading") : t("map.noStationsHere")}</span>
    </div>
  );
}
