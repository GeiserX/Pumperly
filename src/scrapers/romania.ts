import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// Romania — Peco Online (Parse backend)
// ---------------------------------------------------------------------------
// Parse API with publicly known keys. Returns ~1,400 stations with prices.
// Prices in RON (Romanian Leu). Paginated (limit 1000).
// 999999 = no data sentinel value.
//
// `Id` is NOT unique upstream: a station is occasionally listed twice under
// one Id, and a handful of genuinely different stations share an Id. Feeding
// those straight through makes the station upsert batch fail with
// "ON CONFLICT DO UPDATE command cannot affect row a second time", so the
// whole batch (500 stations) is lost on every run. See `externalIdFor()`.
// ---------------------------------------------------------------------------

const API_URL = "https://pg-app-hnf14cfy2xb2v9x9eueuchcd2xyetd.scalabl.cloud/1/classes/farapret3";

const PARSE_HEADERS = {
  "X-Parse-Application-Id": "YueWcf0orjSz3IQmaT8yBNDTM5POP0mOU6EDyE3U",
  "X-Parse-Client-Key": "ctPx9Ahrz9aaXhEvN0oWCzlX8FHX1cv3r7vZwxH8",
  "User-Agent": "Parse Android SDK API Level 34",
  Accept: "application/json",
};

const FUEL_FIELD_MAP: ReadonlyArray<[string, FuelType]> = [
  ["Benzina_Regular", "E5"],
  ["Benzina_Premium", "E5_98"],
  ["Motorina_Regular", "B7"],
  ["Motorina_Premium", "B7_PREMIUM"],
  ["GPL", "LPG"],
  ["AdBlue", "ADBLUE"],
];

interface PecoStation {
  objectId: string;
  Id: string;
  Retea: string;
  Statie: string;
  Adresa: string;
  Oras: string;
  Judet: string;
  lat: number;
  lng: number;
  Benzina_Regular: number;
  Benzina_Premium: number;
  Motorina_Regular: number;
  Motorina_Premium: number;
  GPL: number;
  AdBlue: number;
}

interface ParseResponse {
  results: PecoStation[];
  count?: number;
}

/** Stable per-station coordinate key, used to disambiguate reused `Id`s. */
function coordKey(s: PecoStation): string {
  return `${s.lat},${s.lng}`;
}

/**
 * Build the external id for every row.
 *
 * `Id` alone when it maps to a single location — so existing rows keep their
 * id — and `Id@lat,lng` when upstream reuses one Id for several locations.
 * Duplicate listings of the same station collapse onto the same id either way.
 */
function externalIdFor(rows: PecoStation[]): (s: PecoStation) => string {
  const locationsById = new Map<string, Set<string>>();
  for (const s of rows) {
    const id = s.Id || s.objectId;
    let locations = locationsById.get(id);
    if (!locations) {
      locations = new Set<string>();
      locationsById.set(id, locations);
    }
    locations.add(coordKey(s));
  }
  return (s) => {
    const id = s.Id || s.objectId;
    return (locationsById.get(id)?.size ?? 0) > 1 ? `${id}@${coordKey(s)}` : id;
  };
}

export class RomaniaScraper extends BaseScraper {
  readonly country = "RO";
  readonly source = "peco_online";

  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const rows: PecoStation[] = [];
    const LIMIT = 1000;
    let skip = 0;
    let total = 0;

    // Paginate through all stations with valid prices
    const where = encodeURIComponent(JSON.stringify({
      Benzina_Regular: { $gt: 0, $lt: 999999 },
    }));

    while (true) {
      const url = `${API_URL}?limit=${LIMIT}&skip=${skip}&count=1&where=${where}`;
      const res = await fetch(url, {
        headers: PARSE_HEADERS,
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) throw new Error(`Peco Online HTTP ${res.status}`);
      const data: ParseResponse = await res.json();

      if (skip === 0 && data.count != null) {
        total = data.count;
        console.log(`[${this.source}] Total stations with prices: ${total}`);
      }

      for (const s of data.results) {
        if (!s.lat || !s.lng) continue;
        // Romania bounding box
        if (s.lat < 43.5 || s.lat > 48.3 || s.lng < 20.2 || s.lng > 30.0) continue;
        rows.push(s);
      }

      skip += data.results.length;
      if (data.results.length < LIMIT) break;

      // Small delay between pages
      await new Promise((r) => setTimeout(r, 200));
    }

    // External ids are assigned once, over the full result set, so a reused
    // `Id` is resolved the same way no matter which page each row arrived on.
    const idFor = externalIdFor(rows);
    const stationMap = new Map<string, RawStation>();
    const priceMap = new Map<string, RawFuelPrice>();

    for (const s of rows) {
      const externalId = idFor(s);

      if (!stationMap.has(externalId)) {
        stationMap.set(externalId, {
          externalId,
          name: s.Statie?.trim() || `${s.Retea ?? ""} ${s.Oras ?? ""}`.trim(),
          brand: s.Retea?.trim() || null,
          address: s.Adresa?.trim() || "",
          city: s.Oras?.trim() || "",
          province: s.Judet?.trim() || null,
          latitude: s.lat,
          longitude: s.lng,
          stationType: "fuel",
        });
      }

      for (const [field, fuelType] of FUEL_FIELD_MAP) {
        const price = s[field as keyof PecoStation] as number;
        if (price != null && price > 0 && price < 999999) {
          const key = `${externalId}:${fuelType}`;
          if (!priceMap.has(key)) {
            priceMap.set(key, {
              stationExternalId: externalId,
              fuelType,
              price,
              currency: "RON",
            });
          }
        }
      }
    }

    const stations = Array.from(stationMap.values());
    const prices = Array.from(priceMap.values());
    const duplicateRows = rows.length - stations.length;
    console.log(
      `[${this.source}] Fetched ${stations.length} stations, ${prices.length} prices` +
        (duplicateRows > 0 ? ` (collapsed ${duplicateRows} duplicate rows)` : ""),
    );
    return { stations, prices };
  }
}
