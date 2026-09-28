import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// Iceland — Gasvaktin (github.com/gasvaktin/gasvaktin, MIT)
// ---------------------------------------------------------------------------
// Community-maintained JSON of every fuel station in Iceland with its current
// Bensín 95 and diesel price, refreshed about every 15 minutes. Roughly 245
// stations, all with coordinates. Prices are ISK per litre.
//
// The `*_discount` fields are member-card prices, not the pump price, and are
// ignored. The feed has no street addresses; the station name carries the
// place ("Baldursnes Akureyri").
// ---------------------------------------------------------------------------

const DATA_URL =
  "https://raw.githubusercontent.com/gasvaktin/gasvaktin/master/vaktin/gas.json";

// Iceland bounding box (incl. Westfjords and the Eastfjords)
const LAT_MIN = 63.2;
const LAT_MAX = 66.7;
const LON_MIN = -24.7;
const LON_MAX = -13.3;

interface GasvaktinStation {
  key: string;
  name: string;
  company: string;
  bensin95: number | null;
  bensin95_discount: number | null;
  diesel: number | null;
  diesel_discount: number | null;
  geo: { lat: number; lon: number } | null;
}

const PRICE_FIELDS: ReadonlyArray<[keyof Pick<GasvaktinStation, "bensin95" | "diesel">, FuelType]> = [
  ["bensin95", "E5"],
  ["diesel", "B7"],
];

export class IcelandScraper extends BaseScraper {
  readonly country = "IS";
  readonly source = "gasvaktin";

  /** Read the Gasvaktin JSON and return every priced station with ISK pump prices. */
  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    console.log(`[${this.source}] Fetching ${DATA_URL}`);

    const res = await fetch(DATA_URL, {
      headers: { Accept: "application/json", "User-Agent": "Pumperly/1.0" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Gasvaktin feed returned HTTP ${res.status}`);

    const data: unknown = await res.json();
    const list = (data as { stations?: unknown } | null)?.stations;
    if (!Array.isArray(list)) {
      throw new Error("Gasvaktin feed has no stations array");
    }
    console.log(`[${this.source}] Received ${list.length} raw stations`);

    const stations: RawStation[] = [];
    const prices: RawFuelPrice[] = [];
    const seen = new Set<string>();

    for (const raw of list) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const s = raw as GasvaktinStation;
      if (typeof s.key !== "string" || !s.key) continue;

      const lat = s.geo?.lat;
      const lon = s.geo?.lon;
      if (typeof lat !== "number" || typeof lon !== "number" || !isFinite(lat) || !isFinite(lon)) continue;
      if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) continue;

      const valid: Array<{ fuelType: FuelType; price: number }> = [];
      for (const [field, fuelType] of PRICE_FIELDS) {
        const price = s[field];
        if (typeof price !== "number" || !isFinite(price) || price <= 0) continue;
        valid.push({ fuelType, price });
      }
      if (valid.length === 0) continue;

      if (seen.has(s.key)) continue;
      seen.add(s.key);

      const externalId = `is-gv-${s.key}`;
      const brand = typeof s.company === "string" && s.company.trim() ? s.company.trim() : null;
      const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : externalId;

      stations.push({
        externalId,
        name: brand && !name.startsWith(brand) ? `${brand} ${name}` : name,
        brand,
        address: "",
        city: "",
        province: null,
        latitude: lat,
        longitude: lon,
        stationType: "fuel",
      });

      for (const v of valid) {
        prices.push({
          stationExternalId: externalId,
          fuelType: v.fuelType,
          price: v.price,
          currency: "ISK",
        });
      }
    }

    console.log(`[${this.source}] Processed ${stations.length} stations, ${prices.length} prices`);
    return { stations, prices };
  }
}
