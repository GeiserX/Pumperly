import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// France — data.economie.gouv.fr (OpenDataSoft)
// ---------------------------------------------------------------------------
// Dataset: prix-des-carburants-en-france-flux-instantane-v2
// ~9,800 stations, updated every 10 minutes, Licence Ouverte v2.0
// Uses the bulk export endpoint (single request for all records).
// ---------------------------------------------------------------------------

const EXPORT_URL =
  "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json?select=id,adresse,ville,departement,cp,geom,gazole_prix,sp95_prix,e10_prix,sp98_prix,e85_prix,gplc_prix";

const FUEL_FIELD_MAP: ReadonlyMap<string, FuelType> = new Map([
  ["gazole_prix", "B7"],
  ["sp95_prix", "E5"],
  ["e10_prix", "E10"],
  ["sp98_prix", "E5_98"],
  // e85_prix is not mapped: E85 is not E10, and there is no E85 fuel type.
  // Filing it as E10 showed a ~0.85 EUR "E10" price (see sweden.ts).
  ["gplc_prix", "LPG"],
]);

interface FranceRecord {
  id: number;
  adresse: string;
  ville: string;
  departement: string;
  cp: string;
  geom: { lon: number; lat: number } | null;
  gazole_prix: number | null;
  sp95_prix: number | null;
  e10_prix: number | null;
  sp98_prix: number | null;
  e85_prix: number | null;
  gplc_prix: number | null;
}

export class FranceScraper extends BaseScraper {
  readonly country = "FR";
  readonly source = "economie_gouv";

  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const res = await fetch(EXPORT_URL, {
      headers: { Accept: "application/json", "User-Agent": "Pumperly/1.0" },
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) throw new Error(`France API HTTP ${res.status}`);
    const records: FranceRecord[] = await res.json();

    const stations: RawStation[] = [];
    const prices: RawFuelPrice[] = [];

    for (const r of records) {
      if (!r.geom) continue;
      const { lon, lat } = r.geom;
      if (lat < 41 || lat > 52 || lon < -6 || lon > 10) continue;

      const externalId = String(r.id);
      const city = r.ville?.trim() || "";
      const address = r.adresse?.trim() || "";

      stations.push({
        externalId,
        name: city ? `${city} — ${address}` : address,
        brand: null,
        address,
        city,
        province: r.departement?.trim() || null,
        latitude: lat,
        longitude: lon,
        stationType: "fuel",
      });

      for (const [field, fuelType] of FUEL_FIELD_MAP) {
        const price = r[field as keyof FranceRecord] as number | null;
        if (price != null && price > 0) {
          prices.push({ stationExternalId: externalId, fuelType, price, currency: "EUR" });
        }
      }
    }

    console.log(`[${this.source}] Fetched ${records.length} records via bulk export`);
    return { stations, prices };
  }
}
