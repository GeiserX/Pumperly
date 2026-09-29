"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { FUEL_TYPE_MAP, type FuelType } from "@/types/fuel";

const STORAGE_KEY = "pumperly-vehicle";

export const vehicleProfileSchema = z.object({
  tankL: z.number().finite().min(5).max(500),
  consumptionL100: z.number().finite().min(1).max(50),
});

export type VehicleProfile = z.infer<typeof vehicleProfileSchema>;

export const DEFAULT_VEHICLE: VehicleProfile = { tankL: 50, consumptionL100: 6.5 };

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

export function readVehicleProfile(raw: string | null): VehicleProfile {
  if (!raw) return DEFAULT_VEHICLE;
  try {
    const parsed = vehicleProfileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT_VEHICLE;
  } catch {
    return DEFAULT_VEHICLE;
  }
}

export function useVehicleProfile(): [VehicleProfile, (p: VehicleProfile) => void] {
  const [profile, setProfile] = useState<VehicleProfile>(() => {
    if (typeof window === "undefined") return DEFAULT_VEHICLE;
    try {
      return readVehicleProfile(localStorage.getItem(STORAGE_KEY));
    } catch {
      // Storage blocked (private mode): fall back to defaults.
      return DEFAULT_VEHICLE;
    }
  });

  useEffect(() => {
    if (vehicleProfileSchema.safeParse(profile).success) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
      } catch {
        // Storage blocked or full: profile still applies for this session.
      }
    }
  }, [profile]);

  return [profile, setProfile];
}
