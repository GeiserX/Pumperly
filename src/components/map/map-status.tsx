"use client";

import { useI18n } from "@/lib/i18n";

/** State of the no-route (bounding box) station fetch, as shown on the map. */
export type MapStationsStatus = "idle" | "loading" | "error" | "empty";

interface MapStatusProps {
  status: MapStationsStatus;
  onRetry: () => void;
}

const PILL_CLASS =
  "pointer-events-auto flex items-center gap-3 rounded-full border border-black/10 bg-white/90 px-4 py-2 text-sm font-medium text-gray-800 shadow-md backdrop-blur-md dark:border-white/10 dark:bg-gray-900/90 dark:text-gray-100";

/**
 * A pill at the top centre of the map, below the search card, that says when
 * the stations are loading, failed to load, or none sell this fuel here.
 * Without it each of those looked the same as a bare street map.
 */
export function MapStatus({ status, onRetry }: MapStatusProps) {
  const { t } = useI18n();
  if (status === "idle") return null;

  return (
    <div className="pointer-events-none absolute left-1/2 top-[4.75rem] z-10 flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 justify-center sm:top-[5.25rem]">
      {status === "error" ? (
        <div role="alert" className={PILL_CLASS}>
          <span>{t("map.loadError")}</span>
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
          <span>{status === "loading" ? t("map.loading") : t("map.noStationsHere")}</span>
        </div>
      )}
    </div>
  );
}
