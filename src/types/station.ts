export type StationType = "fuel" | "ev_charger" | "both";

// FuelType is derived from the canonical FUEL_TYPE_CODES tuple in ./fuel.
// Re-exported here so existing `@/types/station` consumers keep working.
export type { FuelType } from "./fuel";
import type { FuelType } from "./fuel";

/**
 * Charges an EV tariff adds on top of its per-kWh price, in the price's
 * currency. `perMinute` starts `afterMin` minutes into the session (0 = from
 * the start). Stored as JSONB in fuel_prices.ev_fees.
 */
export interface EvFees {
  /** The highest session fee that can apply: what cost estimates use. */
  sessionFee?: number;
  /** Set when the session fee depends on the time, day or session. */
  sessionFeeRules?: SessionFeeRule[];
  perMinute?: number;
  afterMin?: number;
}

/** One session fee and when it applies. No fields besides `fee`: always. */
export interface SessionFeeRule {
  fee: number;
  /** "HH:MM" local time. */
  from?: string;
  to?: string;
  /** ISO weekdays, 1 = Monday. */
  days?: number[];
  /** Applies under other conditions too (energy, power, duration...). */
  other?: boolean;
}

export interface Station {
  id: string;
  externalId: string;
  country: string;
  name: string;
  brand: string | null;
  address: string;
  city: string;
  province: string | null;
  latitude: number;
  longitude: number;
  stationType: StationType;
  createdAt: Date;
  updatedAt: Date;
}

export interface FuelPrice {
  id: number;
  stationId: string;
  fuelType: FuelType;
  price: number;
  currency: string;
  reportedAt: Date;
  source: string;
}

export interface StationGeoJSON {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: {
    id: string;
    /** Durable station identity, always emitted by the server (survives scraper re-imports, unlike `id`). Optional in the type only so existing client-built fixtures stay valid. */
    externalId?: string;
    /** ISO 3166-1 alpha-2 country code, always emitted by the server. */
    country?: string;
    name: string;
    brand: string | null;
    address: string;
    city: string;
    price?: number | null;
    reportedAt?: string | null;
    fuelType: string;
    currency: string;
    /** Original price before currency conversion (only set when converted) */
    originalPrice?: number | null;
    /** Original currency code before conversion (only set when converted) */
    originalCurrency?: string;
    /** EV chargers: highest single-connector power in kW (absent when unknown). */
    powerKw?: number;
    /** EV chargers: fees on top of the per-kWh `price` (absent when there are none). */
    evFees?: EvFees;
    routeFraction?: number;
    detourMin?: number;
    /** Distance from the query point in km (only set by /api/stations/nearest) */
    distanceKm?: number;
  };
}

export interface StationsGeoJSONCollection {
  type: "FeatureCollection";
  features: StationGeoJSON[];
}
