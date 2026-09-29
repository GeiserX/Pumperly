"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { StationGeoJSON } from "@/types/station";
import { useI18n } from "@/lib/i18n";
import { useCurrency } from "@/lib/currency";
import { maxStopsFor, planRefuel, type PlanResult } from "@/lib/refuel-planner";
import { useVehicleProfile, vehicleProfileSchema, type VehicleProfile } from "@/lib/vehicle-profile";

export interface PlannedStopMarker {
  id: string;
  coordinates: [number, number];
}

interface RefuelPlannerProps {
  /** Corridor stations (with routeFraction and, once streamed, detourMin). */
  stations: StationGeoJSON[];
  routeKm: number;
  detoursLoading?: boolean;
  /** Map/list filters: stops outside them would have no dot, row or popup. */
  maxPrice?: number | null;
  maxDetour?: number | null;
  selectedStationId?: string | null;
  onStopSelect: (coords: [number, number], stationId: string) => void;
  onStopToggleOff: () => void;
  /** Reports recommended stops (in route order) for the map markers; [] when none. */
  onPlanChange?: (stops: PlannedStopMarker[]) => void;
  /** Owned by the parent so they survive the planner unmounting while the corridor refetches. */
  settings: PlannerSettings;
  onSettingsChange: (settings: PlannerSettings) => void;
}

export interface PlannerSettings {
  open: boolean;
  startPct: number;
  arrivalPct: number;
  reservePct: number;
  /** Stored in EUR so the default means the same everywhere; shown and planned in the display currency. */
  timeValueEur: number;
}

export const DEFAULT_PLANNER_SETTINGS: PlannerSettings = {
  open: false,
  startPct: 50,
  arrivalPct: 20,
  reservePct: 10,
  timeValueEur: 15,
};

export function RefuelPlanner({
  stations,
  routeKm,
  detoursLoading,
  maxPrice,
  maxDetour,
  selectedStationId,
  onStopSelect,
  onStopToggleOff,
  onPlanChange,
  settings,
  onSettingsChange,
}: RefuelPlannerProps) {
  const { t } = useI18n();
  const { currency, symbol, decimals, formatPrice, convert, rates } = useCurrency();
  const [profile, setProfile] = useVehicleProfile();
  const { open, startPct, arrivalPct, reservePct, timeValueEur } = settings;
  const update = (patch: Partial<PlannerSettings>) => onSettingsChange({ ...settings, ...patch });
  // Drafts so a half-typed number ("6.") doesn't get rejected mid-edit.
  const [tankDraft, setTankDraft] = useState(String(profile.tankL));
  const [consDraft, setConsDraft] = useState(String(profile.consumptionL100));
  // Same for the value of time; null shows the saved (and planned) value.
  const [timeDraft, setTimeDraft] = useState<string | null>(null);

  // The time value is stored in EUR: without a rate for the display currency it
  // can't be converted, and `convert` would silently treat it as 1:1.
  const ratesMissing = currency !== "EUR" && !rates?.rates[currency];
  const eurRate = convert(1, "EUR");
  const timeValue = Number((timeValueEur * eurRate).toFixed(Math.min(decimals, 2)));

  const byId = useMemo(() => new Map(stations.map((s) => [s.properties.id, s])), [stations]);

  const plan: PlanResult | null = useMemo(() => {
    if (!open || ratesMissing || detoursLoading || routeKm <= 0) return null;
    const candidates = stations.flatMap((s) => {
      const p = s.properties;
      // Mixed currencies can't be compared; only use prices in the display currency.
      if (p.price == null || p.detourMin == null || p.detourMin < 0 || p.currency !== currency) return [];
      if ((maxPrice != null && p.price > maxPrice) || (maxDetour != null && p.detourMin > maxDetour)) return [];
      return [{ id: p.id, km: (p.routeFraction ?? 0) * routeKm, price: p.price, detourMin: p.detourMin }];
    });
    return planRefuel({
      routeKm,
      stations: candidates,
      tankL: profile.tankL,
      consumptionL100: profile.consumptionL100,
      startPct,
      arrivalPct,
      reservePct,
      timeValuePerHour: timeValue,
      maxStops: maxStopsFor(routeKm, profile.tankL, profile.consumptionL100, reservePct),
    });
  }, [open, ratesMissing, detoursLoading, routeKm, stations, maxPrice, maxDetour, currency, profile, startPct, arrivalPct, reservePct, timeValue]);

  useEffect(() => {
    const stops = plan?.status === "ok"
      ? plan.stops.flatMap((s) => {
          const f = byId.get(s.id);
          return f ? [{ id: s.id, coordinates: f.geometry.coordinates }] : [];
        })
      : [];
    onPlanChange?.(stops);
  }, [plan, byId, onPlanChange]);

  // Clear map markers when the planner unmounts (route cleared).
  useEffect(() => () => onPlanChange?.([]), [onPlanChange]);

  // Commit on blur/Enter: saving on every keystroke would store "8" and "80"
  // on the way to an invalid "800". Invalid input reverts to the saved value.
  const commitField = (key: keyof VehicleProfile, raw: string) => {
    const next = { ...profile, [key]: parseFloat(raw.replace(",", ".")) };
    if (vehicleProfileSchema.safeParse(next).success) setProfile(next);
    else if (key === "tankL") setTankDraft(String(profile.tankL));
    else setConsDraft(String(profile.consumptionL100));
  };
  const commitTimeValue = (raw: string) => {
    const v = parseFloat(raw.replace(",", "."));
    if (!ratesMissing && Number.isFinite(v) && v >= 0) update({ timeValueEur: v / eurRate });
    setTimeDraft(null);
  };
  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  const money = (v: number) => `${v.toFixed(Math.min(decimals, 2))} ${symbol}`;

  return (
    <div className="mt-2 shrink-0 overflow-hidden rounded-2xl border border-black/[0.06] bg-white/90 shadow-xl shadow-black/[0.08] ring-1 ring-black/[0.03] backdrop-blur-xl dark:border-white/[0.07] dark:bg-gray-900/90 dark:shadow-black/40 dark:ring-white/[0.04]">
      <button
        onClick={() => update({ open: !open })}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <span className="text-xs font-bold uppercase tracking-wide text-gray-700 dark:text-gray-200">{t("planner.title")}</span>
        <svg className={`h-3.5 w-3.5 text-gray-500 transition-transform dark:text-gray-400 ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-black/[0.05] dark:border-white/[0.06]">
          {/* Vehicle + trip controls */}
          <div className="px-4 py-2.5">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                {t("planner.tank")}
                <input
                  type="number"
                  inputMode="decimal"
                  min={5}
                  max={500}
                  value={tankDraft}
                  onChange={(e) => setTankDraft(e.target.value)}
                  onBlur={(e) => commitField("tankL", e.target.value)}
                  onKeyDown={blurOnEnter}
                  className="mt-1 w-full rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-xs font-semibold text-gray-800 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-gray-100"
                />
              </label>
              <label className="text-[11px] font-medium text-gray-500 dark:text-gray-400">
                {t("planner.consumption")}
                <input
                  type="number"
                  inputMode="decimal"
                  min={1}
                  max={50}
                  step={0.1}
                  value={consDraft}
                  onChange={(e) => setConsDraft(e.target.value)}
                  onBlur={(e) => commitField("consumptionL100", e.target.value)}
                  onKeyDown={blurOnEnter}
                  className="mt-1 w-full rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-xs font-semibold text-gray-800 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-gray-100"
                />
              </label>
            </div>
            <PctSlider label={t("planner.start")} value={startPct} min={1} onChange={(v) => update({ startPct: v })} />
            <PctSlider label={t("planner.arrival")} value={arrivalPct} min={0} onChange={(v) => update({ arrivalPct: v })} />
            <PctSlider label={t("planner.reserve")} value={reservePct} min={0} max={50} onChange={(v) => update({ reservePct: v })} />
            <label className="mt-2.5 flex items-center justify-between text-[11px] font-medium text-gray-500 dark:text-gray-400">
              {t("planner.timeValue").replace("{cur}", symbol)}
              <input
                type="number"
                inputMode="decimal"
                min={0}
                value={timeDraft ?? String(timeValue)}
                disabled={ratesMissing}
                onChange={(e) => setTimeDraft(e.target.value)}
                onBlur={(e) => commitTimeValue(e.target.value)}
                onKeyDown={blurOnEnter}
                className="w-16 rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-right text-xs font-semibold text-gray-800 disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-gray-100"
              />
            </label>
          </div>

          {/* Result */}
          <div className="border-t border-black/[0.05] dark:border-white/[0.06]">
            {ratesMissing ? (
              <p className="px-4 py-3 text-center text-xs font-medium text-amber-700 dark:text-amber-300">{t("planner.noRates")}</p>
            ) : detoursLoading ? (
              <p className="px-4 py-3 text-center text-xs font-medium text-gray-500 dark:text-gray-400">{t("planner.calculating")}</p>
            ) : plan?.status === "no-stop-needed" ? (
              <p className="px-4 py-3 text-center text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {t("planner.noStop").replace("{pct}", String(Math.round(plan.endPct)))}
              </p>
            ) : plan?.status === "infeasible" ? (
              <p className="px-4 py-3 text-center text-xs font-medium text-amber-700 dark:text-amber-300">
                {plan.reason === "arrival"
                  ? t("planner.infeasibleArrival").replace("{pct}", String(Math.max(arrivalPct, reservePct)))
                  : plan.reason === "no-candidates"
                    ? t("planner.infeasibleNoCandidates")
                    : t("planner.infeasible").replace("{km}", String(Math.round(plan.gapKm ?? 0)))}
              </p>
            ) : plan?.status === "ok" ? (
              <>
                {plan.stops.map((stop, i) => {
                  const f = byId.get(stop.id);
                  if (!f) return null;
                  const active = stop.id === selectedStationId;
                  return (
                    <button
                      key={stop.id}
                      onClick={() => (active ? onStopToggleOff() : onStopSelect(f.geometry.coordinates, stop.id))}
                      className={`flex w-full items-center gap-2.5 border-b border-black/[0.04] px-4 py-2 text-left transition-colors dark:border-white/[0.05] ${
                        active ? "bg-blue-100/80 dark:bg-blue-500/20" : "hover:bg-gray-100/70 dark:hover:bg-white/[0.04]"
                      }`}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-semibold text-gray-800 dark:text-gray-100">{f.properties.brand ?? f.properties.name}</p>
                        <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">
                          {t("route.distance")} {Math.round(stop.km)} · {Math.round(stop.arrivePct)}% → {Math.round(stop.departPct)}% · +{Math.round(stop.detourMin)} {t("route.duration")}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs font-bold tabular-nums text-gray-900 dark:text-gray-50">{money(stop.cost)}</p>
                        <p className="text-[10px] tabular-nums text-gray-500 dark:text-gray-400">
                          {stop.litres.toFixed(1)} L · {formatPrice(f.properties.price ?? 0)} {symbol}/L
                        </p>
                      </div>
                    </button>
                  );
                })}
                <div className="flex items-center justify-between px-4 py-2 text-[11px]">
                  <span className="font-medium text-gray-500 dark:text-gray-400">
                    {t("planner.total")} · {t("planner.atDestination")} {Math.round(plan.endPct)}%
                  </span>
                  <span className="font-bold tabular-nums text-gray-900 dark:text-gray-50">{money(plan.totalFuelCost)}</span>
                </div>
                <FuelGauge plan={plan} routeKm={routeKm} reservePct={reservePct} />
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function PctSlider({ label, value, min, max = 100, onChange }: { label: string; value: number; min: number; max?: number; onChange: (v: number) => void }) {
  return (
    <>
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-gray-500 dark:text-gray-400">{label}</span>
        <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-200">{value}%</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(parseInt(e.target.value))}
        className="mt-1.5 h-1.5 w-full cursor-pointer touch-none rounded-full bg-gray-200 accent-emerald-500 dark:bg-white/10"
      />
    </>
  );
}

/** Fuel level along the route: drops while driving, jumps at each stop. */
function FuelGauge({ plan, routeKm, reservePct }: { plan: PlanResult; routeKm: number; reservePct: number }) {
  const W = 300;
  const H = 48;
  const x = (km: number) => (routeKm > 0 ? (km / routeKm) * W : 0);
  const y = (pct: number) => H - (Math.max(0, Math.min(100, pct)) / 100) * H;
  const points = plan.profile.map((p) => `${x(p.km).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-12 w-full px-4 pb-2" preserveAspectRatio="none" aria-hidden="true">
      <line x1={0} x2={W} y1={y(reservePct)} y2={y(reservePct)} className="stroke-red-400/70" strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      <polyline points={points} fill="none" className="stroke-emerald-500" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
