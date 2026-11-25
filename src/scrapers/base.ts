import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import type { EvFees, FuelType } from "../types/station";

/**
 * Transaction client type — Prisma's interactive transaction callback receives
 * a PrismaClient minus the transaction/connection methods.
 */
type TransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// ---------------------------------------------------------------------------
// Scraper result
// ---------------------------------------------------------------------------

export interface ScraperResult {
  country: string;
  source: string;
  /** Stations this run vouched for: the ones sent in batches that succeeded. */
  stationsUpserted: number;
  /** Prices this run vouched for: one per station, fuel and source. */
  pricesUpserted: number;
  /** Stations actually written: new ones, or ones whose data changed. */
  stationsChanged: number;
  /** Prices actually written: new ones, or ones whose value or date changed. */
  pricesChanged: number;
  /** Prices of this source and country the upstream no longer lists. */
  pricesRemoved: number;
  durationMs: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Normalised intermediate types (what scrapers produce before DB writes)
// ---------------------------------------------------------------------------

export interface RawStation {
  externalId: string;
  name: string;
  brand: string | null;
  address: string;
  city: string;
  province: string | null;
  latitude: number;
  longitude: number;
  stationType: "fuel" | "ev_charger" | "both";
  /** EV chargers: highest single-connector power in kW, null/unset when unknown. */
  maxPowerKw?: number | null;
}

/** A published charger power as kW, or null when missing or implausible (≤ 0 or > 1000). */
export function sanePowerKw(kw: number | null | undefined): number | null {
  if (typeof kw !== "number" || !Number.isFinite(kw) || kw > 1000) return null;
  const rounded = Math.round(kw);
  return rounded > 0 ? rounded : null;
}

/**
 * The highest plausible power among a charger's connectors, kW. Each value is
 * checked before comparing, so one bogus reading can't hide a valid one.
 */
export function maxSanePowerKw(kws: Iterable<number | null | undefined>): number | null {
  let max: number | null = null;
  for (const kw of kws) {
    const sane = sanePowerKw(kw);
    if (sane != null && (max == null || sane > max)) max = sane;
  }
  return max;
}

export interface RawFuelPrice {
  /** Must match a RawStation.externalId in the same batch */
  stationExternalId: string;
  fuelType: FuelType;
  price: number; // per litre in local currency (per kWh for EV)
  currency: string; // ISO 4217
  /** EV only: fees on top of the per-kWh price. */
  evFees?: EvFees;
  /**
   * When the upstream last vouched for this price. Unset: the row is stored
   * with a NULL reported_at and dated by this source's last successful run.
   */
  reportedAt?: Date;
}

/** A charger price per kWh the map can show. Only EUR chargers are priced today. */
export function isPlausibleEvPrice(price: number, currency: string): boolean {
  return currency === "EUR" && price >= 0.1 && price <= 2;
}

export interface EvSweepOptions {
  /** externalId prefix this scraper writes, e.g. "bnetza-". */
  ownPrefix: string;
  /** Prefixes of the sources this one replaces in the same country. */
  retirePrefixes: string[];
  /** Fewer of this run's stations found in the database than this, and nothing is deleted. */
  minStations: number;
  /** For the log lines, e.g. "the register". */
  label: string;
}

// ---------------------------------------------------------------------------
// Write-on-change SQL
// ---------------------------------------------------------------------------
// A run sends its whole set, but only rows whose content differs from the
// database reach the INSERT. The pre-filter matters: a plain
// `ON CONFLICT DO UPDATE ... WHERE ... IS DISTINCT FROM` still locks, and so
// dirties and logs, every conflicting row even when nothing changed.
// Rows travel as one jsonb parameter per statement, which keeps clear of the
// 65,535 bind-parameter limit. Each INSERT takes its rows in key order, so two
// runs of the same source lock rows in the same order and cannot deadlock on
// the upsert.

/** Upsert of one station batch ($1 rows as jsonb, $2 country). */
export function stationUpsertSql(withPower: boolean): string {
  const power = (sql: string) => (withPower ? sql : "");
  return `
    WITH inc AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
        external_id text, name text, brand text, address text, city text, province text,
        station_type text, lon float8, lat float8${power(", max_power_kw smallint")})
    ),
    src AS (
      SELECT inc.*, ST_SetSRID(ST_MakePoint(inc.lon, inc.lat), 4326) AS geom FROM inc
    ),
    changed AS (
      SELECT src.* FROM src
      LEFT JOIN stations s ON s.external_id = src.external_id AND s.country = $2
      WHERE s.id IS NULL
         OR (s.name, s.brand, s.address, s.city, s.province, s.station_type, s.geom${power(", s.max_power_kw")})
            IS DISTINCT FROM
            (src.name, src.brand, src.address, src.city, src.province, src.station_type::varchar(20), src.geom${power(", src.max_power_kw")})
    )
    INSERT INTO stations (external_id, country, name, brand, address, city, province, station_type, geom, ${power("max_power_kw, ")}created_at, updated_at)
    SELECT external_id, $2, name, brand, address, city, province, station_type, geom, ${power("max_power_kw, ")}NOW(), NOW()
    FROM changed
    ORDER BY external_id COLLATE "C"
    ON CONFLICT (external_id, country) DO UPDATE SET
      name         = EXCLUDED.name,
      brand        = EXCLUDED.brand,
      address      = EXCLUDED.address,
      city         = EXCLUDED.city,
      province     = EXCLUDED.province,
      station_type = EXCLUDED.station_type,
      geom         = EXCLUDED.geom,${power("\n      max_power_kw = EXCLUDED.max_power_kw,")}
      updated_at   = NOW()
  `;
}

/** Upsert of one price chunk ($1 rows as jsonb, $2 source). */
export const PRICE_UPSERT_SQL = `
  WITH inc AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
      station_id uuid, fuel_type text, price numeric, currency text, ev_fees jsonb, reported_at timestamptz)
  ),
  changed AS (
    SELECT inc.* FROM inc
    LEFT JOIN fuel_prices fp
      ON fp.station_id = inc.station_id AND fp.fuel_type = inc.fuel_type AND fp.source = $2
    WHERE fp.id IS NULL
       OR (fp.price, fp.currency, fp.ev_fees, fp.reported_at)
          IS DISTINCT FROM
          (inc.price::numeric(10,3), inc.currency::varchar(3), inc.ev_fees, inc.reported_at)
  )
  INSERT INTO fuel_prices (station_id, fuel_type, price, currency, source, ev_fees, reported_at)
  SELECT station_id, fuel_type, price, currency, $2, ev_fees, reported_at
  FROM changed
  ORDER BY station_id, fuel_type COLLATE "C"
  ON CONFLICT (station_id, fuel_type, source) DO UPDATE SET
    price       = EXCLUDED.price,
    currency    = EXCLUDED.currency,
    ev_fees     = EXCLUDED.ev_fees,
    reported_at = EXCLUDED.reported_at
`;

/**
 * Delete the prices of this source and country the run did not list
 * ($1 source, $2 country, $3 every (station_id, fuel_type) of the run as jsonb).
 * Together with the upsert this leaves exactly the rows a full replace would.
 *
 * NOT IN, not NOT EXISTS, on purpose: Postgres guesses 100 rows for any
 * jsonb_to_recordset, and on a table without statistics (a new install) it
 * planned NOT EXISTS as a nested loop that rescans the whole list for every
 * price: 100 s for 15k prices. NOT IN is never turned into a join; it runs
 * as one hashed subplan whatever the estimates. No NULLs on either side.
 */
export const PRICE_REMOVE_SQL = `
  DELETE FROM fuel_prices fp
  USING stations s
  WHERE fp.station_id = s.id
    AND s.country = $2
    AND fp.source = $1
    AND (fp.station_id, fp.fuel_type::text) NOT IN (
      SELECT k.station_id, k.fuel_type
      FROM jsonb_to_recordset($3::jsonb) AS k(station_id uuid, fuel_type text)
    )
`;

/**
 * Date this run ($1 country, $2 source). Prices with a NULL reported_at show
 * this time. NOW() is the transaction start, so it commits with the prices.
 */
export const SCRAPE_RUN_SQL = `
  INSERT INTO scrape_runs (country, source, last_success_at)
  VALUES ($1, $2, NOW())
  ON CONFLICT (country, source) DO UPDATE SET last_success_at = EXCLUDED.last_success_at
`;

/**
 * Keep one price per station and fuel. The kept one is the one the readers
 * would show if both were stored: the newest reportedAt, where an undated
 * price counts as newest (it is dated by this run), and on a tie the first
 * emitted.
 */
export function dedupePrices(prices: RawFuelPrice[]): RawFuelPrice[] {
  const rank = (p: RawFuelPrice) => (p.reportedAt ? p.reportedAt.getTime() : Infinity);
  const at = new Map<string, number>();
  const kept: RawFuelPrice[] = [];
  for (const p of prices) {
    const key = `${p.stationExternalId}\u0000${p.fuelType}`;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, kept.length);
      kept.push(p);
    } else if (rank(p) > rank(kept[i])) {
      kept[i] = p;
    }
  }
  return kept;
}

/** Code-point order, the same as Postgres's COLLATE "C". */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Per-currency price validation bands
// ---------------------------------------------------------------------------
// Reject obviously bad prices (placeholders, wrong units) using per-currency
// plausible per-litre ranges. EUR/GBP/CHF additionally respect the
// PUMPERLY_PRICE_MIN / PUMPERLY_PRICE_MAX env overrides (see run()).

interface PriceBand {
  min: number;
  max: number;
}

const PRICE_BANDS: Record<string, PriceBand> = {
  EUR: { min: 0.5, max: 4.0 },
  GBP: { min: 0.4, max: 3.5 },
  CHF: { min: 0.5, max: 4.5 },
  HUF: { min: 200, max: 2000 },
  RON: { min: 3, max: 30 },
  RSD: { min: 60, max: 600 },
  TRY: { min: 10, max: 400 },
  PLN: { min: 2, max: 20 },
  CZK: { min: 10, max: 150 },
  BGN: { min: 1, max: 10 },
  MKD: { min: 30, max: 300 },
  BAM: { min: 1, max: 10 },
  MDL: { min: 10, max: 100 },
  SEK: { min: 6, max: 60 },
  ISK: { min: 100, max: 700 },
  TWD: { min: 15, max: 80 },
  NOK: { min: 7, max: 70 },
  DKK: { min: 6, max: 60 },
  MXN: { min: 8, max: 100 },
  ARS: { min: 200, max: 20000 }, // wide: high inflation — review periodically
  AUD: { min: 0.5, max: 5.0 },
};

const DEFAULT_BAND: PriceBand = { min: 0.1, max: 100000 };

export function bandFor(currency: string): PriceBand {
  return PRICE_BANDS[currency] ?? DEFAULT_BAND;
}

// ---------------------------------------------------------------------------
// Abstract scraper contract
// ---------------------------------------------------------------------------

export abstract class BaseScraper {
  abstract readonly country: string; // ISO 3166-1 alpha-2
  abstract readonly source: string; // e.g. "miteco"

  /**
   * Fetch stations + prices from the upstream data source.
   * Each implementation must normalise the raw API response into
   * `RawStation[]` and `RawFuelPrice[]`.
   */
  abstract fetch(): Promise<{
    stations: RawStation[];
    prices: RawFuelPrice[];
  }>;

  // ---------------------------------------------------------------------------
  // Common persistence logic
  // ---------------------------------------------------------------------------

  /**
   * External ids of the stations the last run() wrote or confirmed, i.e. the
   * ones in station batches that succeeded. The EV sweeps use it to tell a
   * charger that left the upstream from one that is simply unchanged.
   */
  protected lastRunExternalIds: string[] = [];

  /**
   * Run the full scrape-and-persist pipeline.
   *
   * 1. Fetch upstream data via the country-specific `fetch()`.
   * 2. Batch-upsert stations, writing only new or changed ones.
   * 3. In one transaction: upsert the changed prices, delete the ones the
   *    upstream no longer lists, and record the run in scrape_runs.
   */
  async run(): Promise<ScraperResult> {
    const start = Date.now();
    const errors: string[] = [];
    let stationsUpserted = 0;
    let pricesUpserted = 0;
    let stationsChanged = 0;
    let pricesChanged = 0;
    let pricesRemoved = 0;
    this.lastRunExternalIds = [];
    const result = (): ScraperResult => ({
      country: this.country,
      source: this.source,
      stationsUpserted,
      pricesUpserted,
      stationsChanged,
      pricesChanged,
      pricesRemoved,
      durationMs: Date.now() - start,
      errors,
    });

    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });

    try {
      console.log(
        `[${this.source}] Fetching data for ${this.country} ...`,
      );

      const { stations, prices } = await this.fetch();

      // ------------------------------------------------------------------
      // 0a. Reject obviously bad prices (placeholders, wrong units) using
      //     per-currency plausible per-litre bands (see PRICE_BANDS).
      //     EUR/GBP/CHF additionally honour the PUMPERLY_PRICE_MIN /
      //     PUMPERLY_PRICE_MAX env overrides; all other currencies use
      //     bandFor(currency).
      // ------------------------------------------------------------------
      // Parse a numeric env var, falling back to the default if missing or
      // malformed (a NaN here would silently disable price validation).
      const parseEnvNum = (raw: string | undefined, def: number): number => {
        if (raw == null) return def;
        const v = parseFloat(raw);
        return Number.isFinite(v) ? v : def;
      };
      const priceMin = parseEnvNum(process.env.PUMPERLY_PRICE_MIN, 0.3);
      const priceMax = parseEnvNum(process.env.PUMPERLY_PRICE_MAX, 4.0);
      const ALT_FUELS = new Set(["H2", "CNG", "LNG", "ADBLUE"]);
      const badPriceBefore = prices.length;
      const validPrices = prices.filter((p) => {
        if (p.price <= 0) return false;
        // Per kWh, not per litre.
        if (p.fuelType === "EV") return isPlausibleEvPrice(p.price, p.currency);
        if (ALT_FUELS.has(p.fuelType)) return p.price >= 0.05 && p.price < 100;
        if (p.currency === "EUR" || p.currency === "GBP" || p.currency === "CHF")
          return p.price >= priceMin && p.price <= priceMax;
        const band = bandFor(p.currency);
        return p.price >= band.min && p.price <= band.max;
      });
      const badPrices = badPriceBefore - validPrices.length;
      if (badPrices > 0) {
        console.log(`[${this.source}] Filtered out ${badPrices} invalid prices`);
      }

      // The table holds one price per station, fuel and source. Some sources
      // list a fuel twice for a station (Italy's self-service and served
      // prices, France's E85 mapped to E10); keep the one readers showed.
      const uniquePrices = dedupePrices(validPrices);
      const duplicatePrices = validPrices.length - uniquePrices.length;
      if (duplicatePrices > 0) {
        console.log(`[${this.source}] Kept one of several prices for the same station and fuel: dropped ${duplicatePrices}`);
      }

      // ------------------------------------------------------------------
      // 0b. Drop fuel-only stations that have no valid prices (keep EV chargers)
      // ------------------------------------------------------------------
      const stationsWithPrices = new Set(validPrices.map((p) => p.stationExternalId));
      const filteredStations = stations.filter(
        (s) => stationsWithPrices.has(s.externalId) || s.stationType !== "fuel",
      );
      const dropped = stations.length - filteredStations.length;

      console.log(
        `[${this.source}] Fetched ${stations.length} stations, ${prices.length} price rows` +
          (dropped > 0 ? ` (dropped ${dropped} with no prices)` : ""),
      );

      // ------------------------------------------------------------------
      // 0c. Empty-fetch guard (CRITICAL).
      //     An HTTP-200 upstream that returns empty/garbage-but-parseable
      //     data must NOT wipe a whole country. If there are no stations to
      //     persist (filteredStations keeps EV chargers even with no prices,
      //     so genuine EV runs still proceed; a truly empty fetch aborts),
      //     skip the destructive price-replace and orphan-cleanup entirely.
      // ------------------------------------------------------------------
      if (filteredStations.length === 0) {
        const msg = `Aborted destructive replace: fetch returned 0 stations / ${validPrices.length} valid prices`;
        errors.push(msg);
        console.error(`[${this.source}] ${msg}`);
        return result();
      }

      // ------------------------------------------------------------------
      // 1. Upsert stations in batches. Only new or changed stations are
      //    written; an unchanged one keeps its row and its updated_at.
      // ------------------------------------------------------------------
      const STATION_BATCH = 500;
      let stationBatchFailed = false;
      for (let i = 0; i < filteredStations.length; i += STATION_BATCH) {
        const batch = filteredStations.slice(i, i + STATION_BATCH);
        try {
          stationsChanged += await this.upsertStationBatch(prisma, batch);
          stationsUpserted += batch.length;
          for (const s of batch) this.lastRunExternalIds.push(s.externalId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Station batch ${i}-${i + batch.length}: ${msg}`);
          stationBatchFailed = true;
        }
      }

      console.log(`[${this.source}] Stations: ${stationsUpserted} current, ${stationsChanged} written`);

      // ------------------------------------------------------------------
      // 2. Prices, in one transaction so readers never see a half-written
      //    run: upsert the ones that changed, delete the ones the upstream
      //    no longer lists, and date the run in scrape_runs. Scoped by
      //    country, so scrapers sharing a source name (like "anwb" for
      //    NL/BE/LU) don't touch each other's rows.
      // ------------------------------------------------------------------
      const PRICE_CHUNK = 5000;

      // Build a lookup: externalId -> stationId (UUID)
      const stationRows: Array<{ id: string; external_id: string }> =
        await prisma.$queryRawUnsafe(
          `SELECT id, external_id FROM stations WHERE country = $1`,
          this.country,
        );
      const extToId = new Map(stationRows.map((r) => [r.external_id, r.id]));

      // Resolve prices, as the rows the SQL reads from jsonb. Sorted by key,
      // so the chunks of two concurrent runs lock rows in the same order.
      const resolvedPrices = uniquePrices
        .flatMap((p) => {
          const stationId = extToId.get(p.stationExternalId);
          if (!stationId) return [];
          return [
            {
              station_id: stationId,
              fuel_type: p.fuelType as string,
              price: p.price,
              currency: p.currency,
              ev_fees: p.evFees ?? null,
              reported_at: p.reportedAt ? p.reportedAt.toISOString() : null,
            },
          ];
        })
        .sort((a, b) => byCodePoint(a.station_id, b.station_id) || byCodePoint(a.fuel_type, b.fuel_type));
      pricesUpserted = resolvedPrices.length;
      const keys = JSON.stringify(resolvedPrices.map((p) => ({ station_id: p.station_id, fuel_type: p.fuel_type })));

      const written = await prisma.$transaction(
        async (tx: TransactionClient) => {
          let changed = 0;
          for (let i = 0; i < resolvedPrices.length; i += PRICE_CHUNK) {
            const chunk = resolvedPrices.slice(i, i + PRICE_CHUNK);
            changed += Number(await tx.$executeRawUnsafe(PRICE_UPSERT_SQL, JSON.stringify(chunk), this.source)) || 0;
          }
          const removed = Number(await tx.$executeRawUnsafe(PRICE_REMOVE_SQL, this.source, this.country, keys)) || 0;
          await tx.$executeRawUnsafe(SCRAPE_RUN_SQL, this.country, this.source);
          return { changed, removed };
        },
        { timeout: 120_000 },
      );
      pricesChanged = written.changed;
      pricesRemoved = written.removed;

      console.log(
        `[${this.source}] Prices: ${pricesUpserted} current, ${pricesChanged} written, ${pricesRemoved} removed`,
      );

      // ------------------------------------------------------------------
      // 3. Clean up orphaned fuel stations (no prices from any source)
      //    Skipped entirely if any station upsert batch failed — otherwise
      //    we'd orphan-delete stations whose upsert never landed this run.
      // ------------------------------------------------------------------
      if (stationBatchFailed) {
        const msg =
          "Skipped orphan cleanup: one or more station batches failed (would have deleted unwritten stations)";
        errors.push(msg);
        console.error(`[${this.source}] ${msg}`);
      } else {
        const cleaned: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
          `WITH deleted AS (
             DELETE FROM stations
             WHERE country = $1
               AND station_type = 'fuel'
               AND NOT EXISTS (
                 SELECT 1 FROM fuel_prices fp WHERE fp.station_id = stations.id
               )
             RETURNING id
           ) SELECT count(*) FROM deleted`,
          this.country,
        );
        const cleanedCount = Number(cleaned[0]?.count ?? 0);
        if (cleanedCount > 0) {
          console.log(`[${this.source}] Cleaned up ${cleanedCount} stations with no prices`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Fatal: ${msg}`);
      console.error(`[${this.source}] Fatal error:`, msg);
    } finally {
      await prisma.$disconnect();
    }

    return result();
  }

  // ---------------------------------------------------------------------------
  // Batch helpers (use raw SQL for PostGIS geometry + performance)
  // ---------------------------------------------------------------------------

  /**
   * Upsert a batch of stations in one statement, writing only the new ones
   * and the ones whose data differs from the database (stationUpsertSql).
   * Returns how many rows it wrote.
   */
  private async upsertStationBatch(
    prisma: PrismaClient,
    batch: RawStation[],
  ): Promise<number> {
    if (batch.length === 0) return 0;

    // Only charger batches write max_power_kw: fuel stations never have a
    // power, so fuel batches leave the column alone.
    const withPower = batch.some((s) => s.stationType !== "fuel");
    const rows = batch.map((s) => ({
      external_id: s.externalId,
      name: s.name,
      brand: s.brand,
      address: s.address,
      city: s.city,
      province: s.province,
      station_type: s.stationType,
      lon: s.longitude,
      lat: s.latitude,
      ...(withPower ? { max_power_kw: s.maxPowerKw ?? null } : {}),
    }));

    const written = await prisma.$executeRawUnsafe(stationUpsertSql(withPower), JSON.stringify(rows), this.country);
    return Number(written) || 0;
  }

  // ---------------------------------------------------------------------------
  // EV sweep
  // ---------------------------------------------------------------------------

  /**
   * Take out the EV rows nothing else will. `run()` only orphan-cleans
   * price-less `fuel` stations, so EV rows accumulate forever:
   *
   *   1. Own rows the last run did not list: chargers that left the upstream,
   *      or whose derived ID churned because coordinates were corrected.
   *   2. The rows of the sources this one replaces (`retirePrefixes`). A
   *      country is served by exactly one EV source at a time, so once this
   *      one has landed those are pure duplicates.
   *
   * "Listed" is the set of external ids the last run() sent in station
   * batches that succeeded (`lastRunExternalIds`), not a timestamp: an
   * unchanged charger is no longer rewritten, so its updated_at stays old.
   *
   * Both deletes are gated on a DB-counted floor: how many of this run's ids
   * the database actually holds. Yesterday's 74k rows cannot vouch for a
   * degraded fetch that listed 42; only the 42 count.
   */
  protected async sweepEvRows(opts: EvSweepOptions): Promise<void> {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    try {
      const own = `${opts.ownPrefix}%`;
      const listed = JSON.stringify(this.lastRunExternalIds);

      // Both statements test membership through a subplan Postgres hashes
      // once (an IN inside FILTER, a NOT IN), never a join it might plan as
      // a nested loop over the list. See PRICE_REMOVE_SQL.
      const counts: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
        `SELECT count(*) FILTER (WHERE external_id IN (SELECT jsonb_array_elements_text($3::jsonb))) AS count
         FROM stations
         WHERE country = $1 AND station_type = 'ev_charger'
           AND external_id LIKE $2`,
        this.country,
        own,
        listed,
      );
      const refreshed = Number(counts[0]?.count ?? 0);
      if (refreshed < opts.minStations) {
        console.warn(
          `[${this.source}] Only ${refreshed} station(s) listed by this run ` +
            `(floor ${opts.minStations}) — skipping cleanup`,
        );
        return;
      }

      const stale: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
        `WITH deleted AS (
           DELETE FROM stations
           WHERE country = $1
             AND station_type = 'ev_charger'
             AND external_id LIKE $2
             AND external_id NOT IN (SELECT jsonb_array_elements_text($3::jsonb))
           RETURNING id
         ) SELECT count(*) FROM deleted`,
        this.country,
        own,
        listed,
      );
      const staleCount = Number(stale[0]?.count ?? 0);
      if (staleCount > 0) {
        console.log(`[${this.source}] Removed ${staleCount} station(s) no longer in ${opts.label}`);
      }

      if (opts.retirePrefixes.length === 0) return;
      const retired: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
        `WITH deleted AS (
           DELETE FROM stations
           WHERE country = $1
             AND station_type = 'ev_charger'
             AND external_id LIKE ANY($2::text[])
           RETURNING id
         ) SELECT count(*) FROM deleted`,
        this.country,
        opts.retirePrefixes.map((p) => `${p}%`),
      );
      const retiredCount = Number(retired[0]?.count ?? 0);
      if (retiredCount > 0) {
        console.log(
          `[${this.source}] Retired ${retiredCount} superseded row(s) ` +
            `(${opts.retirePrefixes.join(", ")}) for ${this.country} ` +
            `(${refreshed} ${opts.label} stations listed this run)`,
        );
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  }
}
