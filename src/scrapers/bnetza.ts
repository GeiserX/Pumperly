import { z } from "zod";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { BaseScraper, type RawFuelPrice, type RawStation, type ScraperResult } from "./base";

// ---------------------------------------------------------------------------
// BNetzA Ladesäulenregister — official German EV charging point registry
// ---------------------------------------------------------------------------
// File:    https://lade.info/data/stationen_XXXX.txt  (~19 MB TSV, daily)
// Source:  Bundesnetzagentur. Every operator of a publicly accessible charge
//          point must file it under §5 Ladesäulenverordnung, so this is the
//          authoritative German register where OpenChargeMap is crowdsourced.
// Licence: CC BY 4.0. Required attribution string: "Bundesnetzagentur.de"
//          (see components/nav/legal-modal.tsx). No API key, no signup.
//
// Caveat worth knowing: the register only publishes operators who completed the
// notification procedure AND consented to publication, so it is not exhaustive.
// It is still several times larger than OpenChargeMap's German coverage.
//
// TWO THINGS SHAPE THIS FILE.
//
// 1. Rows are per-Ladeeinrichtung, not per-location. The Q-Park garage at
//    Landhausstraße 2 in Dresden is five identical rows. Left alone those
//    become five map pins — and worse, `base.ts` upserts in 500-row batches
//    with a single multi-row `INSERT ... ON CONFLICT DO UPDATE`, which
//    Postgres rejects with 21000 CARDINALITY_VIOLATION when two rows in the
//    same statement hit the same conflict target. `base.run()` catches that
//    per batch, so one duplicate silently discards 499 good stations and
//    disables orphan cleanup for the run. It only fires when the duplicates
//    land in the same slice, so it fails intermittently rather than loudly.
//    Hence: merge before returning, and make the merge key and the externalId
//    THE SAME FUNCTION. Deriving the ID from anything coarser than the merge
//    key re-introduces the collision. (Measured on the real file: 74,223
//    unique 5-decimal coordinate pairs but 75,359 coordinate+street pairs —
//    1,136 coordinates carry two different street spellings, so keying the ID
//    on coordinates while merging on coordinates+street would mint exactly
//    1,136 duplicate IDs.)
//
//    Note this departs from the repo's other dedupes (ocm.ts, germany.ts,
//    argentina.ts) — those collapse overlapping fetch windows and take
//    first-or-last. This one merges rows that are genuinely distinct upstream.
//
// 2. `base.run()`'s orphan cleanup only ever deletes `station_type = 'fuel'`,
//    so EV rows are never garbage-collected by the framework. A derived ID
//    churns whenever an operator corrects its coordinates, and every churned
//    ID would leak a permanent pin. Hence the staleness sweep in run().
// ---------------------------------------------------------------------------

const BASE_URL = "https://lade.info/data/stationen_XXXX.txt";

// Overall deadline, not an idle timeout: a download still making progress is
// killed anyway when it expires. ~19 MB uncompressed, ~3-4 MB on the wire once
// undici negotiates gzip, so this is many times more headroom than needed.
const DOWNLOAD_TIMEOUT_MS = 300_000;

// Germany's bounding box, generously padded. Catches coordinate typos that are
// syntactically fine but geographically impossible — the register currently
// holds one (a Lemgo charger published at longitude 4, true value ~8.9).
const DE_BBOX = { latMin: 47, latMax: 56, lonMin: 5.5, lonMax: 15.5 };

// Merge granularity, in decimal places. 5 dp is ~1.1 m, which collapses the
// per-Ladeeinrichtung rows of one site without merging neighbours. Measured
// alternatives on the real file: 4 dp yields 70,236 stations and demonstrably
// folds together distinct chargers; raw unrounded strings yield 76,441 and
// leave sub-metre duplicates behind. This value is baked into every externalId
// ever written, so changing it re-mints ~74k rows — treat it as a migration.
const COORD_PRECISION = 5;

// Floor gating the two destructive sweeps in run(). A degraded fetch that still
// clears the empty-fetch guard must not be able to retire OpenChargeMap or bulk
// delete yesterday's stations. The register holds ~74k; 10k is a wide margin.
const rawMinStations = Number(process.env.PUMPERLY_BNETZA_MIN_STATIONS ?? "10000");
const MIN_STATIONS =
  Number.isFinite(rawMinStations) && rawMinStations > 0 ? Math.floor(rawMinStations) : 10_000;

// Slack added to the staleness cutoff so the sweep can never delete a row
// written in the opening moments of the run it belongs to.
const SWEEP_MARGIN_SECONDS = 300;

// Share of merged rows that may disagree on operator before it is worth
// flagging. Measured at ~1.2% on the real file, which is colocated chargers run
// by different companies, not a merge fault.
const OPERATOR_CONFLICT_WARN_RATIO = 0.05;

// Columns consumed, by header name. Resolved by name rather than fixed index so
// that an inserted column upstream cannot silently shift latitude into
// longitude — the failure mode of positional parsing is bad data, not an error.
const COLUMNS = {
  operator: "Betreiber",
  addressExtra: "Adresszusatz",
  street: "Straße",
  houseNumber: "Hausnummer",
  postcode: "Postleitzahl",
  city: "Ort",
  latitude: "Breitengrad",
  longitude: "Längengrad",
  status: "Status",
} as const;

type ColumnIndices = Record<keyof typeof COLUMNS, number>;

// Every field is a `string` by construction after splitting on tabs, so a
// shape-only schema here would be incapable of failing. Zod earns its place by
// owning the string→number conversion instead.
//
// Deliberately NOT z.coerce.number(): under zod 4 it maps "" and null to 0,
// which would manufacture a coordinate at Null Island out of a blank cell. The
// regex rejects "", " ", "8,9" and "abc" alike.
const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a decimal number")
  .transform(Number);

const CoordinatesSchema = z.object({
  latitude: decimal,
  longitude: decimal,
});

export interface BnetzaParseStats {
  /** Non-blank data rows seen (excludes the header). */
  totalRows: number;
  /** Wrong field count, or coordinates that are not decimal numbers. */
  malformed: number;
  /** Status column is not "1". A business filter, not a parse failure. */
  notOperational: number;
  /** Syntactically valid coordinates that fall outside Germany. */
  outOfBbox: number;
  /** Rows folded into a station already seen. */
  mergedDuplicates: number;
  /** Merged rows whose operator disagreed — a signal the key over-merges. */
  operatorConflicts: number;
}

/**
 * A handful of fields use RFC4180 quoting (`"Hotel ""Zur Mühle"" GmbH"`).
 * Those fields never contain tabs or newlines, so splitting the file remains
 * safe and this is only needed to clean up the values for display.
 */
export function unquote(field: string): string {
  const s = field.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"').trim();
  }
  return s;
}

/**
 * The merge key, which is also the externalId. See the header comment: these
 * must be one and the same function or the batch upsert breaks.
 *
 * Exported so a test can pin the merge granularity.
 */
export function stationKey(latitude: number, longitude: number): string {
  return `bnetza-${latitude.toFixed(COORD_PRECISION)}_${longitude.toFixed(COORD_PRECISION)}`;
}

/**
 * Map header names to column positions.
 *
 * Throws when a column is missing or renamed. That is deliberate: `base.run()`
 * catches it and returns a no-op run, so an upstream format change costs a
 * scrape cycle instead of corrupting the table.
 */
function resolveColumns(headerLine: string): ColumnIndices {
  const header = headerLine
    .replace(/^﻿/, "")
    .split("\t")
    .map((h) => unquote(h).toLowerCase());

  const indices = {} as ColumnIndices;
  for (const [field, name] of Object.entries(COLUMNS) as Array<
    [keyof typeof COLUMNS, string]
  >) {
    const idx = header.indexOf(name.toLowerCase());
    if (idx === -1) {
      throw new Error(`BNetzA: column "${name}" missing from header`);
    }
    indices[field] = idx;
  }
  return indices;
}

/**
 * Parse the register TSV into deduplicated stations.
 *
 * Pure and exported: every filter, the merge and the derived externalId live
 * here, so this is the only part that needs testing and it needs no network.
 */
export function parseBnetzaTsv(text: string): {
  stations: RawStation[];
  stats: BnetzaParseStats;
} {
  // `\r?\n` rather than `\n`: the file is LF today, but a CRLF republish would
  // otherwise append a stray \r to the last column and break the status filter.
  const lines = text.split(/\r?\n/);
  const cols = resolveColumns(lines[0] ?? "");
  const fieldCount = (lines[0] ?? "").split("\t").length;

  const stats: BnetzaParseStats = {
    totalRows: 0,
    malformed: 0,
    notOperational: 0,
    outOfBbox: 0,
    mergedDuplicates: 0,
    operatorConflicts: 0,
  };

  const byKey = new Map<string, RawStation>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue; // blank and trailing lines are not errors
    stats.totalRows++;

    // Split inside the loop and discard. `lines.map(l => l.split("\t"))` would
    // hold ~117k arrays alive at once (~125 MB) — that, not the 19 MB download,
    // is what would OOM the 512 MB app container.
    const fields = line.split("\t");
    if (fields.length !== fieldCount) {
      stats.malformed++;
      continue;
    }

    if (unquote(fields[cols.status]) !== "1") {
      stats.notOperational++;
      continue;
    }

    const parsed = CoordinatesSchema.safeParse({
      latitude: unquote(fields[cols.latitude]),
      longitude: unquote(fields[cols.longitude]),
    });
    if (!parsed.success) {
      stats.malformed++;
      continue;
    }
    const { latitude, longitude } = parsed.data;

    // Range checks stay out of the schema, matching ocm.ts and reve.ts: an
    // implausible coordinate is a value problem, not a shape problem, and
    // conflating the two makes the "malformed" counter useless as a signal.
    if (
      latitude < DE_BBOX.latMin ||
      latitude > DE_BBOX.latMax ||
      longitude < DE_BBOX.lonMin ||
      longitude > DE_BBOX.lonMax
    ) {
      stats.outOfBbox++;
      continue;
    }

    const key = stationKey(latitude, longitude);
    const operator = unquote(fields[cols.operator]);

    const existing = byKey.get(key);
    if (existing) {
      stats.mergedDuplicates++;
      if (operator && existing.brand && operator !== existing.brand) {
        stats.operatorConflicts++;
      }
      continue;
    }

    const street = unquote(fields[cols.street]);
    const houseNumber = unquote(fields[cols.houseNumber]);
    const addressExtra = unquote(fields[cols.addressExtra]);
    const postcode = unquote(fields[cols.postcode]);
    const streetLine = [street, houseNumber].filter(Boolean).join(" ");

    // `name` is the search fallback and the small grey line in the results
    // list, not the popup heading (that shows brand + address). Carry both
    // Adresszusatz and the street: Adresszusatz is present on only ~18% of rows
    // and is as often a bare "Parkplatz" or an asset code ("T175-IT1-1322-212")
    // as a real site label, so on its own it disambiguates nothing — while the
    // street alone loses the one useful case, two chargers at one address.
    const label = [addressExtra, streetLine].filter(Boolean).join(", ");
    const name = [operator, label].filter(Boolean).join(" — ") || key;

    byKey.set(key, {
      externalId: key,
      name,
      brand: operator || null,
      address: [streetLine, postcode].filter(Boolean).join(", ") || name,
      city: unquote(fields[cols.city]),
      // No Bundesland column, and PLZ→Bundesland is not a function: 04xxx,
      // 34xxx, 37xxx and 49xxx each straddle Land borders. Nothing in the app
      // renders province, and germany.ts already writes null for DE.
      province: null,
      latitude,
      longitude,
      stationType: "ev_charger",
    });
  }

  return { stations: [...byKey.values()], stats };
}

export class BNetzAScraper extends BaseScraper {
  readonly country = "DE";
  readonly source = "bnetza";

  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const res = await fetch(BASE_URL, {
      headers: {
        Accept: "text/plain",
        "User-Agent": "Pumperly/1.0 (+https://pumperly.com)",
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`BNetzA HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }

    // ~19 MB buffered. Peak heap lands around 80-100 MB including the merged
    // stations, which the container absorbs; see the note on the split above
    // for the part that actually matters. Body.text() decodes UTF-8 and strips
    // a BOM per spec, so neither needs handling here.
    const { stations, stats } = parseBnetzaTsv(await res.text());

    console.log(
      `[${this.source}] DE: ${stats.totalRows} rows → ${stations.length} stations ` +
        `(merged ${stats.mergedDuplicates}, skipped ${stats.notOperational} not operational, ` +
        `${stats.outOfBbox} out of bounds, ${stats.malformed} malformed)`,
    );
    // ~1% of merges disagree on operator — colocated chargers run by different
    // companies, which is real and expected. Only warn if that share jumps,
    // which is what over-merging would actually look like.
    if (stats.operatorConflicts > stats.mergedDuplicates * OPERATOR_CONFLICT_WARN_RATIO) {
      console.warn(
        `[${this.source}] DE: ${stats.operatorConflicts} of ${stats.mergedDuplicates} merged ` +
          `row(s) disagreed on operator — the merge precision may be too coarse`,
      );
    }

    // The register publishes no tariff of any kind, and an EV tariff is per-kWh
    // and per-session anyway, which fuel_prices cannot express. Nothing is
    // invented here.
    return { stations, prices: [] };
  }

  /**
   * Run the normal pipeline, then take out the rows nothing else will.
   *
   * `base.run()` only orphan-cleans price-less `fuel` stations, so EV rows
   * accumulate forever. Two sweeps are needed:
   *
   *   1. Stations that left the register (or whose derived ID churned because
   *      an operator corrected its coordinates) — without this the map degrades
   *      monotonically, one stale pin per correction.
   *   2. The OpenChargeMap rows this source replaces. Germany is served by
   *      exactly one EV source (see germany-ev-source.ts), so once BNetzA has
   *      landed, the `ocm-` rows are pure duplicates. Unlike Spain's REVE
   *      handover there is no gradual backfill to wait out: this file arrives
   *      complete in a single run, so one healthy run is the whole cutover.
   *
   * Both are gated on a DB-counted floor rather than on the `stationsUpserted`
   * the pipeline reports, because that figure is `batch.length` regardless of
   * what the database actually did. The count covers only rows this run
   * touched: yesterday's 74k rows must not vouch for a degraded fetch that
   * refreshed 42 of them, or sweep 1 would delete the other 73,958 and sweep 2
   * would retire OpenChargeMap on the strength of a near-empty file.
   */
  async run(): Promise<ScraperResult> {
    const result = await super.run();
    if (result.errors.length > 0) return result;

    try {
      await this.sweep(result.durationMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.source}] Cleanup failed: ${msg}`);
      result.errors.push(`Cleanup: ${msg}`);
    }
    return result;
  }

  private async sweep(runDurationMs: number): Promise<void> {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    try {
      // Cutoff expressed as a duration back from the database clock rather than
      // as an app-side timestamp, so clock skew between app and DB cannot make
      // this delete rows that were just written. The same cutoff separates
      // "refreshed by this run" from "stale" below, so a row is always on
      // exactly one side of it.
      const staleSeconds = runDurationMs / 1000 + SWEEP_MARGIN_SECONDS;

      const counts: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
        `SELECT count(*) FROM stations
         WHERE country = 'DE' AND station_type = 'ev_charger'
           AND external_id LIKE 'bnetza-%'
           AND updated_at >= NOW() - make_interval(secs => $1::float8)`,
        staleSeconds,
      );
      const refreshed = Number(counts[0]?.count ?? 0);
      if (refreshed < MIN_STATIONS) {
        console.warn(
          `[${this.source}] Only ${refreshed} station(s) refreshed by this run ` +
            `(floor ${MIN_STATIONS}) — skipping cleanup`,
        );
        return;
      }

      const stale: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
        `WITH deleted AS (
           DELETE FROM stations
           WHERE country = 'DE'
             AND station_type = 'ev_charger'
             AND external_id LIKE 'bnetza-%'
             AND updated_at < NOW() - make_interval(secs => $1::float8)
           RETURNING id
         ) SELECT count(*) FROM deleted`,
        staleSeconds,
      );
      const staleCount = Number(stale[0]?.count ?? 0);
      if (staleCount > 0) {
        console.log(`[${this.source}] Removed ${staleCount} station(s) no longer in the register`);
      }

      const retired: Array<{ count: bigint }> = await prisma.$queryRawUnsafe(
        `WITH deleted AS (
           DELETE FROM stations
           WHERE country = 'DE'
             AND station_type = 'ev_charger'
             AND external_id LIKE 'ocm-%'
           RETURNING id
         ) SELECT count(*) FROM deleted`,
      );
      const retiredCount = Number(retired[0]?.count ?? 0);
      if (retiredCount > 0) {
        console.log(
          `[${this.source}] Retired ${retiredCount} superseded OpenChargeMap row(s) for DE ` +
            `(${refreshed} registry stations refreshed this run)`,
        );
      }
    } finally {
      await prisma.$disconnect().catch(() => {});
    }
  }
}
