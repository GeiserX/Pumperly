import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// Austria — E-Control Spritpreisrechner API (grid-based)
// ---------------------------------------------------------------------------
// API: api.e-control.at/sprit/1.0/search/gas-stations/by-address
// Returns the 10 nearest stations with prices for each coordinate + fuel type.
// We use a ~15km grid covering Austria to ensure full coverage.
// Fuel types: DIE (diesel), SUP (super 95), GAS (super E10)
//
// Only the 5 cheapest of the 10 carry a price; the rest come back with
// `prices: []`. Closed stations are asked for too (`includeClosed=true`), and
// they keep their price when they rank among the 5. With
// `includeClosed=false`, every station that closed for the night dropped out
// of the run: its prices were deleted, then the station itself, and in the
// morning both came back under a new id. On 2026-11-25 the runs at 05:00 and
// 07:00 local time alone re-created 648 stations this way. A closed station's
// price is still the one it charges when it opens.
//
// A station that drops out of the 5 cheapest for every fuel loses its prices
// but stays listed, so it is kept (`keepListedStations`). Without that, the
// daytime runs deleted 119 to 142 such stations each and re-created them
// under a new id once they ranked again.
// ---------------------------------------------------------------------------

const BASE_URL =
  "https://api.e-control.at/sprit/1.0/search/gas-stations/by-address";

// E-Control fuel type codes → harmonized
const FUEL_TYPE_MAP: ReadonlyMap<string, FuelType> = new Map([
  ["DIE", "B7"],
  ["SUP", "E5"],
  ["GAS", "E10"],
]);

// Austria bounding box
const LAT_MIN = 46.37;
const LAT_MAX = 48.91;
const LON_MIN = 9.53;
const LON_MAX = 17.16;
// ~15km spacing
const LAT_STEP = 0.135;
const LON_STEP = 0.2;

interface EControlStation {
  id: number;
  name: string;
  location: {
    address: string;
    city: string;
    postalCode: string;
    latitude: number;
    longitude: number;
  };
  prices: Array<{
    fuelType: string;
    amount: number;
    label: string;
  }>;
  open: boolean;
}

/** Build a grid of lat/lon points covering Austria. */
function buildGrid(): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let lat = LAT_MIN; lat <= LAT_MAX; lat += LAT_STEP) {
    for (let lon = LON_MIN; lon <= LON_MAX; lon += LON_STEP) {
      points.push([lat, lon]);
    }
  }
  return points;
}

export class AustriaScraper extends BaseScraper {
  readonly country = "AT";
  readonly source = "econtrol";
  protected readonly keepListedStations = true;

  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const stationMap = new Map<number, RawStation>();
    // Track best price per station+fuelType (keep cheapest from overlapping grid queries)
    const priceKey = (stationId: string, fuel: string) =>
      `${stationId}:${fuel}`;
    const priceMap = new Map<string, RawFuelPrice>();

    const grid = buildGrid();
    let queryCount = 0;

    for (const [ecFuel, fuelType] of FUEL_TYPE_MAP) {
      for (const [lat, lon] of grid) {
        const url = `${BASE_URL}?latitude=${lat}&longitude=${lon}&fuelType=${ecFuel}&includeClosed=true`;
        try {
          const res = await fetch(url, {
            headers: {
              Accept: "application/json",
              "User-Agent": "Pumperly/1.0",
            },
            signal: AbortSignal.timeout(15_000),
          });

          if (!res.ok) continue;

          const data: EControlStation[] = await res.json();

          for (const s of data) {
            if (!s.location?.latitude || !s.location?.longitude) continue;
            const { latitude: sLat, longitude: sLon } = s.location;
            if (sLat < 46 || sLat > 49 || sLon < 9 || sLon > 18) continue;

            const externalId = String(s.id);

            if (!stationMap.has(s.id)) {
              stationMap.set(s.id, {
                externalId,
                name: s.name?.trim() || `Station ${externalId}`,
                brand: null,
                address: s.location.address?.trim() || "",
                city: s.location.city?.trim() || "",
                province: null,
                latitude: sLat,
                longitude: sLon,
                stationType: "fuel",
              });
            }

            for (const p of s.prices) {
              if (p.amount > 0) {
                const mappedFuel = FUEL_TYPE_MAP.get(p.fuelType) ?? fuelType;
                const key = priceKey(externalId, mappedFuel);
                const existing = priceMap.get(key);
                if (!existing || p.amount < existing.price) {
                  priceMap.set(key, {
                    stationExternalId: externalId,
                    fuelType: mappedFuel,
                    price: p.amount,
                    currency: "EUR",
                  });
                }
              }
            }
          }
        } catch {
          // skip failed grid points silently
        }

        queryCount++;
        // Rate limit: 50ms between requests
        if (queryCount % 10 === 0) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      console.log(
        `[${this.source}] After ${ecFuel}: ${stationMap.size} unique stations, ${queryCount} queries`,
      );
    }

    return {
      stations: Array.from(stationMap.values()),
      prices: Array.from(priceMap.values()),
    };
  }
}
