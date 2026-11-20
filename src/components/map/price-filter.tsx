"use client";

import { useEffect, useMemo, useRef } from "react";
import type { StationsGeoJSONCollection } from "@/types/station";
import { PRICE_COLORS } from "./price-legend";
import { useI18n } from "@/lib/i18n";
import { useCurrency } from "@/lib/currency";

interface PriceFilterProps {
  stations: StationsGeoJSONCollection;
  /** The stations the map actually draws (after the max-price and detour filters). The legend labels name only these. */
  drawnStations?: StationsGeoJSONCollection;
  maxPrice: number | null;
  onMaxPriceChange: (price: number | null) => void;
  /** P5/P95 percentile range from station-layer (for the color legend) */
  legendMin: number | null;
  legendMax: number | null;
}

function priceRange(collection: StationsGeoJSONCollection, cap: number | null) {
  let min: number | null = null;
  let max: number | null = null;
  let pricedCount = 0;
  for (const f of collection.features) {
    const p = f.properties.price;
    if (p == null || (cap != null && p > cap)) continue;
    pricedCount++;
    if (min == null || p < min) min = p;
    if (max == null || p > max) max = p;
  }
  return { min, max, pricedCount };
}

export function PriceFilter({
  stations,
  drawnStations,
  maxPrice,
  onMaxPriceChange,
  legendMin,
  legendMax,
}: PriceFilterProps) {
  const { t } = useI18n();
  const { symbol: currencySymbol, formatPrice, decimals, currency } = useCurrency();

  // Reset filter when currency changes (old value is meaningless in new currency)
  const prevCurrencyRef = useRef(currency);
  useEffect(() => {
    if (prevCurrencyRef.current !== currency) {
      prevCurrencyRef.current = currency;
      onMaxPriceChange(null);
    }
  }, [currency, onMaxPriceChange]);

  const { min, max, pricedCount } = useMemo(() => priceRange(stations, null), [stations]);

  // The ends of the legend name only stations that are drawn: without the
  // stations hidden by the max-price filter (and, on a route, by the detour
  // filter, which only drawnStations reflects).
  const drawn = useMemo(
    () => priceRange(drawnStations ?? stations, maxPrice),
    [drawnStations, stations, maxPrice],
  );

  // Build gradient string for the color legend
  const gradient = useMemo(() => {
    return PRICE_COLORS.map((c, i) => {
      const pct = (i / (PRICE_COLORS.length - 1)) * 100;
      return `${c} ${pct.toFixed(0)}%`;
    }).join(", ");
  }, []);

  const hasLegend = legendMin != null && legendMax != null;
  const hasFilter = min != null && max != null && pricedCount >= 2 && max - min >= 0.005;

  if (!hasLegend && !hasFilter) return null;

  const factor = Math.pow(10, decimals);
  const step = 1 / factor;
  // The 1e-9 nudge stops float error from moving an exact price a step out
  // (1.005 * 1000 is 1004.9999999999999, so a bare floor would give 1.004).
  const roundDown = (n: number) => Math.floor(n * factor + 1e-9) / factor;
  const roundUp = (n: number) => Math.ceil(n * factor - 1e-9) / factor;
  const sliderMin = hasFilter ? roundDown(min) : 0;
  const sliderMax = hasFilter ? roundUp(max) : 1;
  const currentValue = maxPrice ?? sliderMax;
  const isActive = hasFilter && maxPrice != null && maxPrice < sliderMax;
  // The colours spread over P5..P95, but the labels show the real cheapest and
  // dearest drawn prices, so no dot on the map lies outside the labels. With no
  // filter on, they are the slider's ends: the card shows one range, not two.
  const legendLow = drawn.min != null ? roundDown(drawn.min) : (legendMin ?? 0);
  const legendHigh = drawn.max != null ? roundUp(drawn.max) : (legendMax ?? 0);

  const filteredCount = isActive
    ? stations.features.filter(
        (f) => f.properties.price != null && f.properties.price <= maxPrice,
      ).length
    : pricedCount;

  return (
    <div className="absolute bottom-[calc(1.5rem+env(safe-area-inset-bottom))] left-3 z-10 flex w-[184px] flex-col gap-2 rounded-lg border border-black/10 bg-white/70 px-3 py-2.5 shadow-md backdrop-blur-md dark:border-white/10 dark:bg-gray-900/70">
      {/* Color legend gradient */}
      {hasLegend && (
        <div>
          <div
            className="h-2 w-full rounded-full"
            style={{ background: `linear-gradient(to right, ${gradient})` }}
          />
          <div className="mt-1 flex justify-between text-[10px] font-semibold tabular-nums text-gray-600 dark:text-gray-400">
            <span>{formatPrice(legendLow)} {currencySymbol}</span>
            <span>{formatPrice(legendHigh)} {currencySymbol}</span>
          </div>
        </div>
      )}

      {/* Price filter slider */}
      {hasFilter && (
        <div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-semibold text-gray-600 dark:text-gray-400">{t("filter.maxPrice")}</span>
            {isActive && (
              <button
                onClick={() => onMaxPriceChange(null)}
                className="text-[9px] font-medium text-emerald-600 hover:text-emerald-700"
              >
                {t("filter.clear")}
              </button>
            )}
          </div>

          <input
            type="range"
            min={sliderMin}
            max={sliderMax}
            step={step}
            value={currentValue}
            aria-label={t("filter.maxPrice")}
            aria-valuetext={`${formatPrice(currentValue)} ${currencySymbol}`}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              onMaxPriceChange(v >= sliderMax ? null : v);
            }}
            className="h-6 w-full cursor-pointer touch-none appearance-none bg-transparent accent-emerald-500 [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-gray-200 [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-gray-200 [&::-webkit-slider-thumb]:-mt-[7px] [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-500 [&::-webkit-slider-thumb]:shadow-sm sm:[&::-webkit-slider-thumb]:-mt-1 sm:[&::-webkit-slider-thumb]:h-3.5 sm:[&::-webkit-slider-thumb]:w-3.5"
          />

          <div className="mt-0.5 flex items-center justify-between">
            <span className="text-[10px] tabular-nums text-gray-400">{formatPrice(sliderMin)} {currencySymbol}</span>
            <span className={`text-[11px] font-bold tabular-nums ${isActive ? "text-emerald-600" : "text-gray-500"}`}>
              {formatPrice(currentValue)} {currencySymbol}
            </span>
            <span className="text-[10px] tabular-nums text-gray-400">{formatPrice(sliderMax)} {currencySymbol}</span>
          </div>

          {isActive && (
            <p className="mt-0.5 text-center text-[9px] text-gray-400">
              {filteredCount} / {pricedCount}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
