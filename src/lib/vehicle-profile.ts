"use client";

import { useCallback, useState } from "react";
import { z } from "zod";
import { FUEL_TYPE_MAP, type FuelType } from "@/types/fuel";

export const vehicleProfileSchema = z.object({
  tankL: z.number().finite().min(5).max(500),
  consumptionL100: z.number().finite().min(1).max(50),
});

export type VehicleProfile = z.infer<typeof vehicleProfileSchema>;

export const DEFAULT_VEHICLE: VehicleProfile = { tankL: 50, consumptionL100: 6.5 };

/** Stored apart from the fuel profile so each keeps its own values. */
export const evProfileSchema = z.object({
  batteryKwh: z.number().finite().min(10).max(200),
  consumptionKwh100: z.number().finite().min(5).max(50),
  /** Peak charging power the car accepts, kW; AC is also capped at 22. Defaulted so profiles saved before it existed still load. */
  maxChargeKw: z.number().finite().min(10).max(500).default(150),
});

export type EvProfile = z.infer<typeof evProfileSchema>;

export const DEFAULT_EV: EvProfile = { batteryKwh: 60, consumptionKwh100: 18, maxChargeKw: 150 };

/** Assumed for chargers with no published power: slow, so they never beat a known fast one. */
const UNKNOWN_CHARGER_KW = 11;
/** Highest power still treated as AC. */
const MAX_AC_KW = 22;
/** Average over a 10→80 % DC session as a share of peak: charging tapers as the battery fills. */
const DC_TAPER = 0.75;

/** Average charging power (kW) at a charger for a car, for planning. */
export function chargeKw(stationKw: number | null | undefined, carMaxKw: number): number {
  if (stationKw == null || !(stationKw > 0)) return UNKNOWN_CHARGER_KW;
  // AC posts can't charge faster than the car's onboard charger, at most 22 kW.
  if (stationKw <= MAX_AC_KW) return Math.min(stationKw, carMaxKw, MAX_AC_KW);
  return Math.min(stationKw, carMaxKw) * DC_TAPER;
}

/** Minutes to add 1 % of the battery at a charger. */
export function minutesPerPct(ev: EvProfile, stationKw: number | null | undefined): number {
  return ((ev.batteryKwh / 100) / chargeKw(stationKw, ev.maxChargeKw)) * 60;
}

/**
 * Fuels the refuel planner supports: priced per litre and burned by volume.
 * CNG/LNG/H2 are priced per kg, so they are excluded. EV is planned by energy
 * (kWh) alone, since chargers have no prices yet.
 */
export function isPlannableFuel(fuel: FuelType): boolean {
  if (fuel === "EV") return true;
  const info = FUEL_TYPE_MAP.get(fuel);
  if (!info) return false;
  if (info.category === "gasoline" || info.category === "diesel") return true;
  return fuel === "LPG";
}

/** The stored profile, or null when none is stored or it is invalid. */
function parseProfile<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readProfile<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  return parseProfile(raw, schema) ?? fallback;
}

export function readVehicleProfile(raw: string | null): VehicleProfile {
  return readProfile(raw, vehicleProfileSchema, DEFAULT_VEHICLE);
}

export function readEvProfile(raw: string | null): EvProfile {
  return readProfile(raw, evProfileSchema, DEFAULT_EV);
}

export interface StoredProfileState {
  /** No profile of the person's own is stored: the defaults are an example car. */
  isDefault: boolean;
  /** Forgets the stored profile and goes back to the example car. */
  reset: () => void;
}

function sameFields<T>(a: T, b: T): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (x[k] !== y[k]) return false;
  return true;
}

/**
 * Only what the person sets is stored. The defaults are an example car, so
 * they are shown but never written as if they were the person's own.
 */
function useStoredProfile<T>(key: string, schema: z.ZodType<T>, fallback: T): [T, (p: T) => void, StoredProfileState] {
  const [stored, setStored] = useState<T | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const parsed = parseProfile(localStorage.getItem(key), schema);
      // Older versions wrote the example car to storage on first render, so a
      // stored profile equal to it is the example, not the person's own car.
      if (parsed !== null && sameFields(parsed, fallback)) {
        localStorage.removeItem(key);
        return null;
      }
      return parsed;
    } catch {
      // Storage blocked (private mode): fall back to defaults.
      return null;
    }
  });

  const save = useCallback((p: T) => {
    if (!schema.safeParse(p).success) return;
    setStored(p);
    try {
      localStorage.setItem(key, JSON.stringify(p));
    } catch {
      // Storage blocked or full: profile still applies for this session.
    }
  }, [key, schema]);

  const reset = useCallback(() => {
    setStored(null);
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage blocked: nothing was stored.
    }
  }, [key]);

  return [stored ?? fallback, save, { isDefault: stored === null, reset }];
}

export function useVehicleProfile(): [VehicleProfile, (p: VehicleProfile) => void, StoredProfileState] {
  return useStoredProfile("pumperly-vehicle", vehicleProfileSchema, DEFAULT_VEHICLE);
}

export function useEvProfile(): [EvProfile, (p: EvProfile) => void, StoredProfileState] {
  return useStoredProfile("pumperly-ev", evProfileSchema, DEFAULT_EV);
}
