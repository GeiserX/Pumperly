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
  stationsUpserted: number;
  pricesUpserted: number;
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
   * When the upstream last vouched for this price. Unset = now: the row keeps
   * the time its price last changed, and readers show the source's last
   * successful run (price_sources.confirmed_at) on top of it. Set it on every
   * row of a source or on none: in a run that mixes both, the undated rows are
   * dated (and so rewritten) on every run.
   */
  reportedAt?: Date;
}

/** A charger price per kWh the map can show. Only EUR chargers are priced today. */
export function isPlausibleEvPrice(price: number, currency: string): boolean {
  return currency === "EUR" && price >= 0.1 && price <= 2;
}

// A sweep never deletes a row written within the run plus this margin.
const SWEEP_MARGIN_SECONDS = 300;

export interface EvSweepOptions {
  /** externalId prefix this scraper writes, e.g. "bnetza-". */
  ownPrefix: string;
  /** Prefixes of the sources this one replaces in the same country. */
  retirePrefixes: string[];
  /** Fewer of this run's stations found in the database than this, and nothing is deleted. */
  minStations: number;
  /** How long the run took. Rows written within it plus a margin are never swept (see sweepEvRows). */
  runDurationMs: number;
  /** For the log lines, e.g. "the register". */
  label: string;
}

// ---------------------------------------------------------------------------
// Write-on-change SQL
// ---------------------------------------------------------------------------
// A run sends its whole data set, but only rows whose content differs from
// the database are written. Every row write costs a new row version, WAL,
// dead tuples and autovacuum work, and on most runs almost nothing changed.

/** One price row as the sync statement reads it from its jsonb parameter. */
export interface PriceRow {
  station_id: string;
  fuel_type: string;
  price: number;
  currency: string;
  /** The fee object itself, never a JSON string: the payload is stringified once. */
  ev_fees: EvFees | null;
  reported_at: string | null;
}

/**
 * Upsert of one station batch. Rows whose stored content already matches are
 * filtered out before the INSERT: `ON CONFLICT ... DO UPDATE WHERE` alone
 * still locks, and so WAL-logs, every conflicting row. The WHERE on the
 * update is only a guard for a row another run changed in between.
 * Coordinates compare exactly: a JS number goes over the wire as its
 * shortest round-trip text, so float8 stores it bit for bit.
 */
export function stationUpsertSql(rowCount: number, withPower: boolean): string {
  const perRow = withPower ? 11 : 10;
  const power = (sql: string) => (withPower ? sql : "");
  const values: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const o = i * perRow;
    values.push(
      `($${o + 1}::text, $${o + 2}::varchar, $${o + 3}::text, $${o + 4}::text, $${o + 5}::text, ` +
        `$${o + 6}::text, $${o + 7}::text, $${o + 8}::varchar, $${o + 9}::float8, $${o + 10}::float8` +
        power(`, $${o + 11}::smallint`) +
        `)`,
    );
  }
  const cols = (t: string) =>
    `${t}.name, ${t}.brand, ${t}.address, ${t}.city, ${t}.province, ${t}.station_type${power(`, ${t}.max_power_kw`)}`;
  return `
    INSERT INTO stations (external_id, country, name, brand, address, city, province, station_type, geom, ${power("max_power_kw, ")}created_at, updated_at)
    SELECT v.external_id, v.country, v.name, v.brand, v.address, v.city, v.province, v.station_type,
           ST_SetSRID(ST_MakePoint(v.lon, v.lat), 4326), ${power("v.max_power_kw, ")}NOW(), NOW()
    FROM (VALUES ${values.join(",\n      ")})
      AS v(external_id, country, name, brand, address, city, province, station_type, lon, lat${power(", max_power_kw")})
    WHERE NOT EXISTS (
      SELECT 1 FROM stations s
      WHERE s.external_id = v.external_id AND s.country = v.country
        AND (${cols("s")}, ST_X(s.geom), ST_Y(s.geom))
            IS NOT DISTINCT FROM (${cols("v")}, v.lon, v.lat)
    )
    ON CONFLICT (external_id, country)
    DO UPDATE SET
      name         = EXCLUDED.name,
      brand        = EXCLUDED.brand,
      address      = EXCLUDED.address,
      city         = EXCLUDED.city,
      province     = EXCLUDED.province,
      station_type = EXCLUDED.station_type,
      geom         = EXCLUDED.geom,${power("\n      max_power_kw = EXCLUDED.max_power_kw,")}
      updated_at   = NOW()
    WHERE (${cols("stations")}, ST_X(stations.geom), ST_Y(stations.geom))
          IS DISTINCT FROM (${cols("EXCLUDED")}, ST_X(EXCLUDED.geom), ST_Y(EXCLUDED.geom))
  `;
}

/**
 * Serialises two runs of one source in one country ($1 country, $2 source).
 * The scheduler never overlaps a country with itself, but a CLI run can.
 */
export const PRICE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('pumperly:prices:' || $1 || ':' || $2))`;

/**
 * The sort and hashes below hold one source's prices. Postgres's default
 * work_mem of 4 MB would spill them to temp files on every run. SET LOCAL
 * ends with the transaction.
 */
export const PRICE_WORK_MEM_SQL = `SET LOCAL work_mem = '32MB'`;

/**
 * Bring one source's prices in one country to the run's set, writing only
 * what changed ($1 rows as jsonb, $2 source, $3 country, $4 true when the run
 * mixes dated and undated rows). Returns how many rows it deleted, updated
 * and inserted.
 *
 * - del: keys the source no longer lists, and legacy duplicate rows of a key.
 * - upd: rows whose price, currency or fees changed, or whose upstream time
 *   moved. No indexed column changes, so these can be HOT updates when the
 *   heap page has room.
 * - ins: keys the table does not hold yet.
 *
 * Times are statement_timestamp(), not now(): this statement runs after the
 * source lock, so a run that waited on another never writes an older time
 * than the one it waited for.
 *
 * The three touch disjoint rows and share one snapshot. round(…, 3) matches
 * the stored numeric(10,3), so float noise never counts as a change. jsonb
 * compares by value, so the key order inside ev_fees does not matter.
 */
export const PRICE_SYNC_SQL = `
  WITH inc AS MATERIALIZED (
    SELECT r.station_id, r.fuel_type, round(r.price, 3)::numeric(10,3) AS price, r.currency, r.ev_fees,
           COALESCE(r.reported_at, CASE WHEN $4::boolean THEN statement_timestamp() END) AS reported_at
    FROM jsonb_to_recordset($1::jsonb) AS r(
      station_id uuid, fuel_type varchar(20), price numeric, currency varchar(3), ev_fees jsonb, reported_at timestamptz)
  ),
  cur AS MATERIALIZED (
    SELECT fp.id, fp.station_id, fp.fuel_type, fp.price, fp.currency, fp.ev_fees, fp.reported_at,
           row_number() OVER (PARTITION BY fp.station_id, fp.fuel_type ORDER BY fp.id) AS rn
    FROM fuel_prices fp
    JOIN stations s ON s.id = fp.station_id
    WHERE fp.source = $2 AND s.country = $3
  ),
  del AS (
    DELETE FROM fuel_prices f
    USING cur c
    WHERE f.id = c.id
      AND (c.rn > 1 OR NOT EXISTS (
        SELECT 1 FROM inc i WHERE i.station_id = c.station_id AND i.fuel_type = c.fuel_type))
    RETURNING 1
  ),
  upd AS (
    UPDATE fuel_prices f
    SET price = i.price, currency = i.currency, ev_fees = i.ev_fees, reported_at = COALESCE(i.reported_at, statement_timestamp())
    FROM cur c
    JOIN inc i ON i.station_id = c.station_id AND i.fuel_type = c.fuel_type
    WHERE f.id = c.id AND c.rn = 1
      AND ((c.price, c.currency, c.ev_fees) IS DISTINCT FROM (i.price, i.currency, i.ev_fees)
           OR (i.reported_at IS NOT NULL AND i.reported_at IS DISTINCT FROM c.reported_at))
    RETURNING 1
  ),
  ins AS (
    INSERT INTO fuel_prices (station_id, fuel_type, price, currency, ev_fees, reported_at, source)
    SELECT i.station_id, i.fuel_type, i.price, i.currency, i.ev_fees, COALESCE(i.reported_at, statement_timestamp()), $2
    FROM inc i
    WHERE NOT EXISTS (SELECT 1 FROM cur c WHERE c.station_id = i.station_id AND c.fuel_type = i.fuel_type)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM del) AS deleted,
         (SELECT count(*) FROM upd) AS updated,
         (SELECT count(*) FROM ins) AS inserted
`;

/**
 * Record that this run confirmed its source's prices ($1 country, $2 source,
 * $3 true when the run's rows carry their own upstream time). Readers show
 * GREATEST(reported_at, confirmed_at), so an unchanged price still reads as
 * fresh. A dated source gets NULL: its rows keep the upstream time. This is
 * the only write a run with no changes makes.
 */
export const PRICE_SOURCE_MARK_SQL = `
  INSERT INTO price_sources (country, source, confirmed_at)
  VALUES ($1, $2, CASE WHEN $3::boolean THEN NULL ELSE statement_timestamp() END)
  ON CONFLICT (country, source) DO UPDATE SET confirmed_at = EXCLUDED.confirmed_at
`;

interface ResolvedPrice {
  stationId: string;
  fuelType: string;
  price: number;
  currency: string;
  evFees?: EvFees;
  reportedAt?: Date;
}

/**
 * Keep one price per station and fuel: the row the readers showed when every
 * listed row was stored. That is the newest upstream time (an undated row
 * counts as the run's time), then the first one the source lists. Some
 * sources list a fuel twice for one station (Italy's self-service and served
 * prices, several products filed under one fuel type), and the table holds
 * one row per key and source. Price plays no part: the lowest row of a key is
 * often a placeholder (1.000), a stale entry or another product, so picking
 * it would change what the map shows.
 */
export function dedupePrices<T extends ResolvedPrice>(prices: T[], runTime: number = Date.now()): T[] {
  const time = (p: ResolvedPrice) => p.reportedAt?.getTime() ?? runTime;
  const at = new Map<string, number>();
  const kept: T[] = [];
  for (const p of prices) {
    const key = `${p.stationId}\u0000${p.fuelType}`;
    const i = at.get(key);
    if (i === undefined) {
      at.set(key, kept.length);
      kept.push(p);
    } else if (time(p) > time(kept[i])) {
      kept[i] = p;
    }
  }
  return kept;
}

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
   * External ids of the stations the last run() listed, set only when every
   * station batch succeeded. The EV sweeps use it to tell a charger that left
   * the upstream from one that is simply unchanged: an unchanged station is
   * no longer rewritten, so its updated_at says nothing about this run.
   */
  protected lastRunExternalIds: string[] = [];

  /**
   * Keep a fuel station the source still lists even when it has no price.
   * Off by default: the orphan cleanup deletes every fuel station with no
   * price. A source that prices only part of what it lists (E-Control prices
   * the 5 cheapest of each query) turns that into churn: the station is
   * deleted, then re-created under a new id when it gets a price again. A
   * station the database does not hold yet is still added only with a price
   * (step 0b). A station with no price never reaches the map, whose fuel
   * queries need a price for the chosen fuel.
   */
  protected readonly keepListedStations: boolean = false;

  /**
   * Run the full scrape-and-persist pipeline.
   *
   * 1. Fetch upstream data via the country-specific `fetch()`.
   * 2. Upsert stations in batches, writing only new or changed ones.
   * 3. Sync prices in one transaction: delete the keys the source no longer
   *    lists, update the changed ones, insert the new ones, and mark the
   *    source as confirmed in price_sources.
   */
  async run(): Promise<ScraperResult> {
    const start = Date.now();
    const errors: string[] = [];
    let stationsUpserted = 0;
    let pricesUpserted = 0;
    this.lastRunExternalIds = [];

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
        return {
          country: this.country,
          source: this.source,
          stationsUpserted,
          pricesUpserted,
          durationMs: Date.now() - start,
          errors,
        };
      }

      // ------------------------------------------------------------------
      // 1. Upsert stations in batches
      // ------------------------------------------------------------------
      // stationsUpserted counts the stations this run confirmed (the Sweden
      // handover gates on it); stationsWritten counts the rows the database
      // actually inserted or changed.
      const STATION_BATCH = 500;
      let stationBatchFailed = false;
      let stationsWritten = 0;
      for (let i = 0; i < filteredStations.length; i += STATION_BATCH) {
        const batch = filteredStations.slice(i, i + STATION_BATCH);
        try {
          stationsWritten += await this.upsertStationBatch(prisma, batch);
          stationsUpserted += batch.length;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Station batch ${i}-${i + batch.length}: ${msg}`);
          stationBatchFailed = true;
        }
      }
      if (!stationBatchFailed) this.lastRunExternalIds = filteredStations.map((s) => s.externalId);

      console.log(
        `[${this.source}] Stations: ${stationsUpserted} listed, ${stationsWritten} inserted or changed`,
      );

      // ------------------------------------------------------------------
      // 2. Sync prices in one transaction, so readers never see half a run.
      //    Scoped by source and country, so scrapers sharing a source name
      //    (like "anwb" for NL/BE/LU) don't touch each other's rows.
      // ------------------------------------------------------------------

      // Build a lookup: externalId -> stationId (UUID)
      const stationRows: Array<{ id: string; external_id: string }> =
        await prisma.$queryRawUnsafe(
          `SELECT id, external_id FROM stations WHERE country = $1`,
          this.country,
        );
      const extToId = new Map(stationRows.map((r) => [r.external_id, r.id]));

      // Resolve prices
      const resolvedPrices: ResolvedPrice[] = validPrices.flatMap((p) => {
        const stationId = extToId.get(p.stationExternalId);
        if (!stationId) return [];
        return [
          {
            stationId,
            fuelType: p.fuelType,
            price: p.price,
            currency: p.currency,
            evFees: p.evFees,
            reportedAt: p.reportedAt,
          },
        ];
      });

      const uniquePrices = dedupePrices(resolvedPrices, Date.now());
      const collapsed = resolvedPrices.length - uniquePrices.length;
      if (collapsed > 0) {
        console.log(`[${this.source}] Collapsed ${collapsed} duplicate price rows (kept the newest, then the first listed)`);
      }

      const dated = uniquePrices.some((p) => p.reportedAt != null);
      const mixed = dated && uniquePrices.some((p) => p.reportedAt == null);
      const payload: PriceRow[] = uniquePrices.map((p) => ({
        station_id: p.stationId,
        fuel_type: p.fuelType,
        price: p.price,
        currency: p.currency,
        ev_fees: p.evFees ?? null,
        reported_at: p.reportedAt ? p.reportedAt.toISOString() : null,
      }));

      const written = await prisma.$transaction(
        async (tx: TransactionClient) => {
          await tx.$executeRawUnsafe(PRICE_WORK_MEM_SQL);
          await tx.$executeRawUnsafe(PRICE_LOCK_SQL, this.country, this.source);
          const rows: Array<{ deleted: bigint; updated: bigint; inserted: bigint }> =
            await tx.$queryRawUnsafe(PRICE_SYNC_SQL, JSON.stringify(payload), this.source, this.country, mixed);
          await tx.$executeRawUnsafe(PRICE_SOURCE_MARK_SQL, this.country, this.source, dated);
          return rows[0];
        },
        { timeout: 120_000 },
      );
      // Only after the commit: a rolled-back sync reports 0, not the listed count.
      pricesUpserted = uniquePrices.length;

      console.log(
        `[${this.source}] Prices: ${pricesUpserted} listed, ` +
          `${Number(written?.updated ?? 0)} changed, ${Number(written?.inserted ?? 0)} new, ` +
          `${Number(written?.deleted ?? 0)} removed`,
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
        const keep = this.keepListedStations;
        const cleaned: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
          `WITH deleted AS (
             DELETE FROM stations
             WHERE country = $1
               AND station_type = 'fuel'
               AND NOT EXISTS (
                 SELECT 1 FROM fuel_prices fp WHERE fp.station_id = stations.id
               )${keep ? `
               AND NOT (external_id = ANY($2::text[]))` : ""}
             RETURNING id
           ) SELECT count(*) FROM deleted`,
          // Every station the source listed, priced or not: step 0b left the
          // unpriced ones out of the upsert, so lastRunExternalIds lacks them.
          ...(keep ? [this.country, stations.map((s) => s.externalId)] : [this.country]),
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

    return {
      country: this.country,
      source: this.source,
      stationsUpserted,
      pricesUpserted,
      durationMs: Date.now() - start,
      errors,
    };
  }

  // ---------------------------------------------------------------------------
  // Batch helpers (use raw SQL for PostGIS geometry + performance)
  // ---------------------------------------------------------------------------

  /**
   * Upsert a batch of stations, writing only new or changed rows (see
   * stationUpsertSql). Returns how many rows the database wrote.
   */
  private async upsertStationBatch(
    prisma: PrismaClient,
    batch: RawStation[],
  ): Promise<number> {
    if (batch.length === 0) return 0;

    // Only charger batches write max_power_kw: fuel stations never have a
    // power, so fuel batches leave the column alone.
    const withPower = batch.some((s) => s.stationType !== "fuel");

    // 10 params per station: externalId, country, name, brand, address, city,
    // province, stationType, longitude, latitude, plus maxPowerKw for charger
    // batches.
    const params: unknown[] = [];
    for (const s of batch) {
      params.push(
        s.externalId,
        this.country,
        s.name,
        s.brand,
        s.address,
        s.city,
        s.province,
        s.stationType,
        s.longitude,
        s.latitude,
      );
      if (withPower) params.push(s.maxPowerKw ?? null);
    }

    const written = await prisma.$executeRawUnsafe(stationUpsertSql(batch.length, withPower), ...params);
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
   * "Listed" is the set of ids the last run() sent (`lastRunExternalIds`),
   * not a timestamp: an unchanged charger is no longer rewritten, so its
   * updated_at stays old however live it is.
   *
   * Both deletes are gated on a DB-counted floor: how many of this run's ids
   * the database holds. Yesterday's 74k rows must not vouch for a degraded
   * fetch that listed 42 of them.
   *
   * The own-row delete also skips rows written within this run plus a margin,
   * measured back from the database clock. A run of the same source that
   * overlaps this one (a CLI run beside the scheduler) may have just written
   * a charger this run's older list does not hold.
   */
  protected async sweepEvRows(opts: EvSweepOptions): Promise<void> {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    try {
      const own = `${opts.ownPrefix}%`;
      const listed = this.lastRunExternalIds;
      const recentSeconds = opts.runDurationMs / 1000 + SWEEP_MARGIN_SECONDS;

      // unnest() of a bound array: Postgres knows its length, so both
      // statements plan as hash joins, never a nested loop over 74k ids.
      const counts: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
        `SELECT count(*) FROM stations
         WHERE country = $1 AND station_type = 'ev_charger'
           AND external_id LIKE $2
           AND external_id IN (SELECT unnest($3::text[]))`,
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
             AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) AS r(x) WHERE r.x = stations.external_id)
             AND updated_at < NOW() - make_interval(secs => $4::float8)
           RETURNING id
         ) SELECT count(*) FROM deleted`,
        this.country,
        own,
        listed,
        recentSeconds,
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
