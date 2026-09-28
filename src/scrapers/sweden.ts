import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { BaseScraper, type RawFuelPrice, type RawStation, type ScraperResult } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// Sweden — bensinpriser.nu bulk map feed
// ---------------------------------------------------------------------------
// The previous source (DrivstoffAppen, api.drivstoffappen.no/api/v1) was
// retired upstream. As of 2026-09-21 every /api/v1/* path answers
// `HTTP 404 {"statusCode":404,"message":"Endpoint not found"}`, including the
// /authorization-sessions bootstrap the dynamic-token scheme depended on. The
// replacement /api/v3/* endpoints answer
// `HTTP 401 {"statusCode":401,"message":"You are not authorized"}` and no
// longer expose a public way to mint a session, so that API is closed to us.
//
// bensinpriser.nu is Sweden's long-running community price site and was this
// scraper's original source. Its Leaflet map is fed by a single bulk endpoint:
//
//   GET https://bensinpriser.nu/karta/data
//     → JSON array of every station: id, lat, lng, company (brand), address,
//       commune (municipality), county, plus one field per fuel. ~1.3 MB,
//       ~3,100 stations, one request per scrape (the old per-station HTML
//       scrape needed thousands).
//
// Prices are crowd-reported, so only stations with a recent report carry a
// non-null price; the rest are dropped by base.ts's no-price filter.
//
// robots.txt allows every path (`User-agent: * / Allow: /`), verified
// 2026-09-21.
//
// Prices in SEK per litre (per kg for fordonsgas/CNG).
//
// Env: No env vars needed (no auth).
// ---------------------------------------------------------------------------

const DATA_URL = "https://bensinpriser.nu/karta/data";

// Source name of the retired DrivstoffAppen scraper. base.run() only replaces
// prices of its own source, so those rows would otherwise stay forever next to
// the new ones: the same forecourt twice, once with a frozen May 2026 price.
// Sources whose rows can never refresh again: DrivstoffAppen (API gone) and
// the pre-May-2026 bensinpriser_nu scraper (slug ids, prices frozen at March).
const RETIRED_SOURCES = ["drivstoffappen", "bensinpriser_nu"];

// Floor gating the handover in run(): a degraded feed must not be able to
// retire the previous source's stations.
const MIN_STATIONS = 200;

// Sweden bounding box
const LAT_MIN = 55.3;
const LAT_MAX = 69.1;
const LON_MIN = 11.0;
const LON_MAX = 24.2;

/**
 * bensinpriser.nu price field → harmonized EU fuel type.
 *
 * `priceLpg` is deliberately absent: the feed emits it as a byte-for-byte copy
 * of `priceEtanol` (347/347 stations carried identical values on 2026-09-21),
 * and Swedish forecourts sell E85, not autogas. Mapping both would file the
 * same reported price twice under two different fuels.
 *
 * `priceEtanol` is E85. There is no E85 code in FUEL_TYPE_CODES, and filing it
 * as E10 would show an E85 price (~2 SEK cheaper) to everyone filtering for
 * 95-octane E10, so it is dropped as well.
 *
 * `price95` stays E5 (not E10) even though Swedish 95-octane is an E10 blend:
 * that matches the previous scraper and `SE.defaultFuel` in src/lib/config.ts.
 */
const PRICE_FIELD_MAP: ReadonlyArray<readonly [keyof MapStation, FuelType]> = [
  ["price95", "E5"],            // 95 oktan
  ["price98", "E5_98"],         // 98 oktan
  ["priceDiesel", "B7"],        // Diesel
  ["priceBiodiesel", "HVO"],    // HVO100 / biodiesel
  ["priceFordonsgas", "CNG"],   // Fordonsgas (biogas/CNG, priced per kg)
];

/** Placeholder the feed uses for unbranded/independent stations. */
const UNBRANDED = "övriga";

// ---------------------------------------------------------------------------
// Feed response type (verified against live feed 2026-09-21)
// ---------------------------------------------------------------------------

interface MapStation {
  id: number;
  lat: number | null;
  lng: number | null;
  company: string | null;      // brand, e.g. "OKQ8", "Preem", "Övriga"
  address: string | null;
  commune: string | null;      // municipality
  county: string | null;       // län
  link: string;
  price95: number | null;
  price98: number | null;
  priceDiesel: number | null;
  priceLpg: number | null;
  priceEtanol: number | null;
  priceFordonsgas: number | null;
  priceBiodiesel: number | null;
  countyLink: string;
  communeLink: string;
  companyLink: string;
}

// ---------------------------------------------------------------------------
// Scraper
// ---------------------------------------------------------------------------

export class SwedenScraper extends BaseScraper {
  readonly country = "SE";
  readonly source = "bensinpriser";

  /**
   * After a healthy run, retire what the DrivstoffAppen scraper left behind:
   * its prices, then the Swedish fuel stations that end up with no price.
   */
  /**
   * Normal run, then retire the dead DrivstoffAppen rows for Sweden once this
   * source has landed a full, error-free set. The old API is gone for good, so
   * its prices can never refresh again; keeping them would show stale numbers.
   */
  async run(): Promise<ScraperResult> {
    const result = await super.run();
    if (result.errors.length > 0 || result.stationsUpserted < MIN_STATIONS) return result;

    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    try {
      const retired = await prisma.$executeRawUnsafe(
        `DELETE FROM fuel_prices
         WHERE source = ANY($1::text[])
           AND station_id IN (SELECT id FROM stations WHERE country = 'SE')`,
        RETIRED_SOURCES,
      );
      if (retired > 0) {
        const orphans = await prisma.$executeRawUnsafe(
          `DELETE FROM stations
           WHERE country = 'SE' AND station_type = 'fuel'
             AND NOT EXISTS (SELECT 1 FROM fuel_prices fp WHERE fp.station_id = stations.id)`,
        );
        console.log(
          `[${this.source}] Retired ${retired} ${RETIRED_SOURCES.join("/")} prices and ${orphans} stations`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.source}] Handover cleanup failed: ${msg}`);
      result.errors.push(`Cleanup: ${msg}`);
    } finally {
      await prisma.$disconnect();
    }
    return result;
  }

  /** Read the whole bensinpriser.nu map feed and turn it into stations and SEK prices. */
  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    console.log(`[${this.source}] Fetching bulk map feed: ${DATA_URL}`);

    const res = await fetch(DATA_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Pumperly/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      throw new Error(
        `bensinpriser.nu map feed returned HTTP ${res.status}: ${await res.text().catch(() => "")}`,
      );
    }

    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      throw new Error("bensinpriser.nu map feed did not return an array");
    }
    console.log(`[${this.source}] Received ${data.length} raw stations`);

    const stations: RawStation[] = [];
    const prices: RawFuelPrice[] = [];
    const seen = new Set<number>();

    for (const raw of data) {
      // A single bad member must not throw and drop the whole Swedish run.
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const s = raw as MapStation;
      const lat = typeof s.lat === "number" ? s.lat : parseFloat(String(s.lat));
      const lon = typeof s.lng === "number" ? s.lng : parseFloat(String(s.lng));

      if (!lat || !lon || isNaN(lat) || isNaN(lon)) continue;

      // Bounding-box filter
      if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) {
        continue;
      }

      // Only keep stations that carry at least one reported price
      const validPrices: Array<{ fuelType: FuelType; price: number }> = [];
      for (const [field, fuelType] of PRICE_FIELD_MAP) {
        const raw = s[field];
        if (typeof raw !== "number" || !isFinite(raw) || raw <= 0) continue;
        validPrices.push({ fuelType, price: raw });
      }

      if (validPrices.length === 0) continue;

      // Dedup by feed id
      if (seen.has(s.id)) continue;
      seen.add(s.id);

      const externalId = `se-bp-${s.id}`;
      const rawCompany = s.company?.trim() || "";
      const brandName =
        rawCompany && rawCompany.toLowerCase() !== UNBRANDED ? rawCompany : null;
      const city = s.commune?.trim() || "";

      stations.push({
        externalId,
        name: `${brandName ?? ""} ${city}`.trim() || externalId,
        brand: brandName,
        address: s.address?.trim() || "",
        city,
        province: s.county?.trim() || null,
        latitude: lat,
        longitude: lon,
        stationType: "fuel",
      });

      for (const vp of validPrices) {
        prices.push({
          stationExternalId: externalId,
          fuelType: vp.fuelType,
          price: vp.price,
          currency: "SEK",
        });
      }
    }

    console.log(
      `[${this.source}] Processed ${stations.length} stations, ${prices.length} prices`,
    );
    return { stations, prices };
  }
}
