"use client";

import { useEffect, useState } from "react";
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
});

export type EvProfile = z.infer<typeof evProfileSchema>;

export const DEFAULT_EV: EvProfile = { batteryKwh: 60, consumptionKwh100: 18 };

/**
 * Fuels the refuel planner supports: priced per litre and burned by volume.
 * CNG/LNG/H2 are priced per kg and EV has no prices yet, so they are excluded.
 */
export function isPlannableFuel(fuel: FuelType): boolean {
  const info = FUEL_TYPE_MAP.get(fuel);
  if (!info) return false;
  if (info.category === "gasoline" || info.category === "diesel") return true;
  return fuel === "LPG";
}

function readProfile<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function readVehicleProfile(raw: string | null): VehicleProfile {
  return readProfile(raw, vehicleProfileSchema, DEFAULT_VEHICLE);
}

export function readEvProfile(raw: string | null): EvProfile {
  return readProfile(raw, evProfileSchema, DEFAULT_EV);
}

function useStoredProfile<T>(key: string, schema: z.ZodType<T>, fallback: T): [T, (p: T) => void] {
  const [profile, setProfile] = useState<T>(() => {
    if (typeof window === "undefined") return fallback;
    try {
      return readProfile(localStorage.getItem(key), schema, fallback);
    } catch {
      // Storage blocked (private mode): fall back to defaults.
      return fallback;
    }
  });

  useEffect(() => {
    if (schema.safeParse(profile).success) {
      try {
        localStorage.setItem(key, JSON.stringify(profile));
      } catch {
        // Storage blocked or full: profile still applies for this session.
      }
    }
  }, [key, schema, profile]);

  return [profile, setProfile];
}

export function useVehicleProfile(): [VehicleProfile, (p: VehicleProfile) => void] {
  return useStoredProfile("pumperly-vehicle", vehicleProfileSchema, DEFAULT_VEHICLE);
}

export function useEvProfile(): [EvProfile, (p: EvProfile) => void] {
  return useStoredProfile("pumperly-ev", evProfileSchema, DEFAULT_EV);
}
