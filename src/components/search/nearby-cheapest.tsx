"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FuelType, StationGeoJSON, StationsGeoJSONCollection } from "@/types/station";
import { useI18n } from "@/lib/i18n";
import { useConvertedStations, useCurrency, CURRENCIES } from "@/lib/currency";
import { cheapestNearby } from "@/lib/geo";
import { formatDistance } from "@/lib/format";

const RADIUS_KM = 10;
const FETCH_LIMIT = 50;
const SHOWN = 3;

const EMPTY: StationsGeoJSONCollection = { type: "FeatureCollection", features: [] };

interface NearbyCheapestProps {
  /** The user's position, [lng, lat]. */
  userLocation: [number, number];
  selectedFuel: FuelType;
  /** Tap on a row: fly there and open the station's card. */
  onFlyTo: (coords: [number, number], stationId: string) => void;
  /** The listed stations, cheapest first, once a fetch settles (empty on failure). */
  onLoaded?: (stations: StationGeoJSON[]) => void;
}

/**
 * The cheapest stations around the user for the chosen fuel, without a route.
 * Each row names the station, its town, how far it is and its price.
 */
export function NearbyCheapest({ userLocation, selectedFuel, onFlyTo, onLoaded }: NearbyCheapestProps) {
  const { t } = useI18n();
  const { formatPrice } = useCurrency();
  const [loaded, setLoaded] = useState<StationsGeoJSONCollection | null>(null);
  // Latest callback and exact position for the fetch callback below, without
  // making either a fetch dependency.
  const onLoadedRef = useRef(onLoaded);
  const locationRef = useRef(userLocation);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
    locationRef.current = userLocation;
  });

  // Query around the position rounded to ~1 km, so a moving GPS fix does not
  // refetch on every update. Distances shown below use the exact position.
  const lat = userLocation[1].toFixed(2);
  const lon = userLocation[0].toFixed(2);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ lat, lon, radius_km: String(RADIUS_KM), fuel: selectedFuel, limit: String(FETCH_LIMIT) });
    fetch(`/api/stations/nearest?${params}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<StationsGeoJSONCollection>) : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        setLoaded(data);
        onLoadedRef.current?.(cheapestNearby(data.features, locationRef.current, SHOWN).map((s) => s.station));
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoaded(null);
        onLoadedRef.current?.([]);
      });
    return () => controller.abort();
  }, [lat, lon, selectedFuel]);

  const converted = useConvertedStations(loaded ?? EMPTY);
  const rows = useMemo(() => cheapestNearby(converted.features, userLocation, SHOWN), [converted, userLocation]);

  if (!loaded) return null;

  return (
    <div className="mt-2 shrink-0 overflow-hidden rounded-2xl border border-black/[0.06] bg-white/90 shadow-xl shadow-black/[0.08] ring-1 ring-black/[0.03] backdrop-blur-xl dark:border-white/[0.07] dark:bg-gray-900/90 dark:shadow-black/40 dark:ring-white/[0.04]">
      <p className="border-b border-black/[0.05] px-4 py-2 text-xs font-bold uppercase tracking-wide text-gray-700 dark:border-white/[0.06] dark:text-gray-200">
        {t("nearby.title")}
      </p>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400">{t("nearby.empty")}</p>
      ) : (
        rows.map(({ station, distanceKm }, i) => {
          const p = station.properties;
          const sc = CURRENCIES.find((c) => c.code === p.currency);
          const price = p.originalCurrency || sc == null ? formatPrice(p.price!) : p.price!.toFixed(sc.decimals);
          const unit = p.fuelType === "EV" ? "/kWh" : "/L";
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onFlyTo(station.geometry.coordinates, p.id)}
              className={`flex w-full items-center justify-between border-b border-black/[0.04] px-4 py-2 text-left transition-colors last:border-b-0 hover:bg-gray-100/70 dark:border-white/[0.05] dark:hover:bg-white/[0.04] ${
                i === 0 ? "bg-emerald-50/80 dark:bg-emerald-500/[0.08]" : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">{p.brand ?? p.name}</span>
                  {i === 0 && (
                    <span className="shrink-0 rounded-md bg-emerald-500 px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-emerald-950">
                      {t("nearby.cheapest")}
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-gray-500 dark:text-gray-400">
                  {p.city} · {formatDistance(distanceKm)}
                </p>
              </div>
              <span className="ml-3 shrink-0 text-sm font-bold tabular-nums text-gray-900 dark:text-gray-50">
                {p.originalCurrency && <span className="font-normal text-gray-500 dark:text-gray-400">≈ </span>}
                {price} {sc?.symbol ?? p.currency}{unit}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
