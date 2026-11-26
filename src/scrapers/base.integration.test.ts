import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { BaseScraper, stationUpsertSql, type RawFuelPrice, type RawStation } from "./base";

// Drives BaseScraper.run() against a real PostGIS built by the real
// migrations, and checks that a run writes only what changed. A row that was
// written gets a new xmin or ctid, a deleted one disappears, so comparing
// (id, xmin, ctid) before and after a run catches every row write.
const hasDocker = process.env.SKIP_INTEGRATION !== "1";
const d = hasDocker ? describe : describe.skip;

const COUNTRY = "XX";
const MIGRATIONS = resolve(__dirname, "../../prisma/migrations");
const NEW_MIGRATION = "20261125000000_write_on_change";

class FakeScraper extends BaseScraper {
  readonly country = COUNTRY;
  readonly source: string;
  stations: RawStation[] = [];
  prices: RawFuelPrice[] = [];

  constructor(source: string) {
    super();
    this.source = source;
  }

  async fetch() {
    return { stations: this.stations, prices: this.prices };
  }
}

/** An EV source with the same sweep BNetzA and OCPDB run. */
class FakeEvScraper extends FakeScraper {
  floor = 1;
  /** Runs between the pipeline and the sweep, to stand in for an overlapping run. */
  beforeSweep: () => Promise<void> = async () => {};

  async run() {
    const result = await super.run();
    if (result.errors.length > 0) return result;
    await this.beforeSweep();
    await this.sweepEvRows({
      ownPrefix: "fev-",
      retirePrefixes: [],
      minStations: this.floor,
      runDurationMs: result.durationMs,
      label: "the fake feed",
    });
    return result;
  }
}

function station(id: string, i: number, over: Partial<RawStation> = {}): RawStation {
  return {
    externalId: id,
    name: `Station ${i}`,
    brand: i % 3 === 0 ? null : "Brand",
    address: `Street ${i}`,
    city: "City",
    province: i % 2 === 0 ? "P" : null,
    // Coordinates with long decimal expansions, as upstream feeds send them.
    latitude: 40 + i * 0.000123456789,
    longitude: -3 - i * 0.000987654321,
    stationType: "fuel",
    ...over,
  };
}

function fuelSet(n: number) {
  const stations = Array.from({ length: n }, (_, i) => station(`st-${i}`, i));
  const prices: RawFuelPrice[] = stations.flatMap((s, i) => [
    { stationExternalId: s.externalId, fuelType: "B7", price: 1.4 + (i % 97) / 1000, currency: "EUR" },
    { stationExternalId: s.externalId, fuelType: "E5", price: 1.6 + (i % 89) / 1000, currency: "EUR" },
  ]);
  return { stations, prices };
}

d("BaseScraper write-on-change (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let url: string;
  let migrateLog = "";

  const migrate = (dir: string) =>
    execFileSync(process.execPath, [resolve(__dirname, "../../docker/migrate.mjs")], {
      env: { ...process.env, DATABASE_URL: url, MIGRATIONS_DIR: dir },
      encoding: "utf8",
    });

  /** (id, xmin, ctid) of every row, so any write shows up as a difference. */
  async function rowVersions(table: "stations" | "fuel_prices") {
    const { rows } = await client.query<{ id: string; v: string }>(
      `SELECT id::text, xmin::text || ':' || ctid::text AS v FROM ${table}`,
    );
    return new Map(rows.map((r) => [r.id, r.v]));
  }

  function changedRows(before: Map<string, string>, after: Map<string, string>) {
    const written = [...after].filter(([id, v]) => before.get(id) !== v).map(([id]) => id);
    const removed = [...before.keys()].filter((id) => !after.has(id));
    return { written, removed };
  }

  async function walBytes<T>(fn: () => Promise<T>): Promise<{ result: T; bytes: number }> {
    const a = await client.query<{ lsn: string }>("SELECT pg_current_wal_insert_lsn()::text AS lsn");
    const result = await fn();
    const b = await client.query<{ bytes: string }>(
      "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::bigint AS bytes",
      [a.rows[0].lsn],
    );
    return { result, bytes: Number(b.rows[0].bytes) };
  }

  /** What the API shows for each price of a source (the readers' expression). */
  async function shown(source: string) {
    const { rows } = await client.query<{ key: string; price: string; shown: Date }>(
      `SELECT s.external_id || '/' || fp.fuel_type AS key, fp.price::text AS price,
              GREATEST(fp.reported_at, ps.confirmed_at) AS shown
       FROM fuel_prices fp
       JOIN stations s ON s.id = fp.station_id
       LEFT JOIN price_sources ps ON ps.country = s.country AND ps.source = fp.source
       WHERE fp.source = $1 ORDER BY 1`,
      [source],
    );
    return rows;
  }

  async function marker(source: string): Promise<Date | null | undefined> {
    const { rows } = await client.query<{ confirmed_at: Date | null }>(
      `SELECT confirmed_at FROM price_sources WHERE country = $1 AND source = $2`,
      [COUNTRY, source],
    );
    return rows[0]?.confirmed_at;
  }

  beforeAll(async () => {
    // The same server setting the compose file and the Helm chart ship; an
    // image without lz4 refuses to start with it.
    container = await new PostgreSqlContainer("postgis/postgis:17-3.4")
      // autovacuum off keeps background WAL out of the walBytes samples.
      .withCommand(["postgres", "-c", "wal_compression=lz4", "-c", "autovacuum=off"])
      .start();
    url = container.getConnectionUri();
    client = new Client({ connectionString: url });
    await client.connect();
    process.env.DATABASE_URL = url;

    // The database as the previous release left it, with its data: delete-and-
    // insert rows, including two prices for one station and fuel.
    const older = mkdtempSync(join(tmpdir(), "pumperly-migrations-"));
    try {
      for (const name of readdirSync(MIGRATIONS)) {
        if (name !== NEW_MIGRATION) cpSync(join(MIGRATIONS, name), join(older, name), { recursive: true });
      }
      migrate(older);
    } finally {
      rmSync(older, { recursive: true, force: true });
    }
    await client.query(`
      INSERT INTO stations (external_id, country, name, address, city, station_type, geom, updated_at)
      VALUES ('legacy-1', '${COUNTRY}', 'Legacy', 'Street', 'City', 'fuel', ST_SetSRID(ST_MakePoint(-3, 40), 4326), now())`);
    await client.query(`
      INSERT INTO fuel_prices (station_id, fuel_type, price, currency, reported_at, source)
      SELECT id, 'B7', p, 'EUR', now() - interval '1 hour', 'legacy' FROM stations, (VALUES (1.5), (1.7)) v(p)
      WHERE external_id = 'legacy-1'`);

    migrateLog = migrate(MIGRATIONS);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await client?.end();
    await container?.stop();
  });

  it("ships wal_compression=lz4 support in the database image", async () => {
    const { rows } = await client.query<{ wal_compression: string }>("SHOW wal_compression");
    expect(rows[0].wal_compression).toBe("lz4");
  });

  it("migrates a populated database from the previous release, and the migration runs twice cleanly", async () => {
    expect(migrateLog).toContain(`applying ${NEW_MIGRATION}`);
    // Safe to run again over the result (a hand-built schema, a retried pod).
    await client.query("BEGIN");
    await client.query(readFileSync(join(MIGRATIONS, NEW_MIGRATION, "migration.sql"), "utf8"));
    await client.query("COMMIT");

    const idx = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'fuel_prices' ORDER BY 1`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["fuel_prices_pkey", "fuel_prices_station_id_fuel_type_idx"]);
    // No marker yet: readers show exactly the stored reported_at, as before.
    const legacy = await shown("legacy");
    expect(legacy).toHaveLength(2);
  });

  it("collapses legacy duplicates on the first run, then writes nothing for an unchanged run", async () => {
    const legacy = new FakeScraper("legacy");
    legacy.stations = [station("legacy-1", 0, { name: "Legacy", address: "Street", city: "City", brand: null, province: null, latitude: 40, longitude: -3 })];
    legacy.prices = [{ stationExternalId: "legacy-1", fuelType: "B7", price: 1.5, currency: "EUR" }];

    const first = await legacy.run();
    expect(first.errors).toEqual([]);
    const rows = await client.query(`SELECT price::text FROM fuel_prices WHERE source = 'legacy'`);
    expect(rows.rows).toEqual([{ price: "1.500" }]);

    // Same data again: no station and no price row is touched.
    const st0 = await rowVersions("stations");
    const fp0 = await rowVersions("fuel_prices");
    const second = await legacy.run();
    expect(second.errors).toEqual([]);
    expect(changedRows(st0, await rowVersions("stations"))).toEqual({ written: [], removed: [] });
    expect(changedRows(fp0, await rowVersions("fuel_prices"))).toEqual({ written: [], removed: [] });
  });

  it("an unchanged run of 3,000 stations writes no row and almost no WAL; one changed price writes one row", async () => {
    // Leave room in each heap page, so the positive control below can check
    // that a price update is HOT (it needs space on the same page).
    await client.query("ALTER TABLE fuel_prices SET (fillfactor = 90)");
    const scraper = new FakeScraper("bulk");
    const data = fuelSet(3000);
    scraper.stations = data.stations;
    // A duplicate key the upstream lists twice, the second time with a
    // placeholder price: the first listed is kept, as readers showed it.
    scraper.prices = [...data.prices, { stationExternalId: "st-0", fuelType: "B7", price: 1.0, currency: "EUR" }];

    const first = await scraper.run();
    expect(first.errors).toEqual([]);
    expect(first.stationsUpserted).toBe(3000);
    expect(first.pricesUpserted).toBe(6000);
    const st0 = await client.query(`SELECT price::text FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
                                    WHERE s.external_id = 'st-0' AND fp.fuel_type = 'B7'`);
    expect(st0.rows).toEqual([{ price: "1.400" }]);
    const firstMarker = await marker("bulk");
    expect(firstMarker).toBeInstanceOf(Date);

    // Identical second run (no ANALYZE in between, as on a new install).
    const stBefore = await rowVersions("stations");
    const fpBefore = await rowVersions("fuel_prices");
    const repeat = await walBytes(() => scraper.run());
    expect(repeat.result.errors).toEqual([]);
    expect(repeat.result.pricesUpserted).toBe(6000);
    expect(changedRows(stBefore, await rowVersions("stations"))).toEqual({ written: [], removed: [] });
    expect(changedRows(fpBefore, await rowVersions("fuel_prices"))).toEqual({ written: [], removed: [] });
    // Only the price_sources marker and the commit records.
    expect(repeat.bytes).toBeLessThan(64 * 1024);
    // The marker moved, and the API shows it for every unchanged price.
    const secondMarker = await marker("bulk");
    expect(secondMarker!.getTime()).toBeGreaterThan(firstMarker!.getTime());
    const view = await shown("bulk");
    expect(view.every((r) => r.shown.getTime() === secondMarker!.getTime())).toBe(true);

    // Positive control: change one price. Exactly that row is written, HOT,
    // with a new reported_at; the others keep theirs.
    scraper.prices = scraper.prices.map((p) =>
      p.stationExternalId === "st-7" && p.fuelType === "E5" ? { ...p, price: p.price + 0.01 } : p,
    );
    const target = await client.query<{ id: string; reported_at: Date }>(
      `SELECT fp.id::text, fp.reported_at FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
       WHERE s.external_id = 'st-7' AND fp.fuel_type = 'E5'`,
    );
    const fpMid = await rowVersions("fuel_prices");
    const hot0 = await client.query<{ hot: string }>(
      `SELECT n_tup_hot_upd::text AS hot FROM pg_stat_user_tables WHERE relname = 'fuel_prices'`,
    );
    await scraper.run();
    expect(changedRows(fpMid, await rowVersions("fuel_prices"))).toEqual({ written: [target.rows[0].id], removed: [] });
    const after = await client.query<{ price: string; reported_at: Date }>(
      `SELECT price::text, reported_at FROM fuel_prices WHERE id = $1`,
      [target.rows[0].id],
    );
    expect(after.rows[0].price).toBe("1.617");
    expect(after.rows[0].reported_at.getTime()).toBeGreaterThan(target.rows[0].reported_at.getTime());
    // The update did not touch an index (HOT). Stats arrive when the run's
    // backend exits, so poll briefly.
    let hot = 0;
    for (let i = 0; i < 50 && hot <= Number(hot0.rows[0].hot); i++) {
      await new Promise((r) => setTimeout(r, 100));
      await client.query("SELECT pg_stat_clear_snapshot()");
      const h = await client.query<{ hot: string }>(
        `SELECT n_tup_hot_upd::text AS hot FROM pg_stat_user_tables WHERE relname = 'fuel_prices'`,
      );
      hot = Number(h.rows[0].hot);
    }
    expect(hot).toBe(Number(hot0.rows[0].hot) + 1);

    // Can fail: the old delete-and-insert of the same rows writes megabytes.
    const old = await walBytes(async () => {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM fuel_prices WHERE source = 'bulk' AND station_id IN (SELECT id FROM stations WHERE country = $1)`,
        [COUNTRY],
      );
      await client.query(
        `INSERT INTO fuel_prices (station_id, fuel_type, price, currency, reported_at, source)
         SELECT id, f, 1.5, 'EUR', now(), 'bulk' FROM stations, (VALUES ('B7'), ('E5')) v(f)
         WHERE country = $1 AND external_id LIKE 'st-%'`,
        [COUNTRY],
      );
      await client.query("ROLLBACK");
    });
    expect(old.bytes).toBeGreaterThan(20 * repeat.bytes);
  });

  it("rewrites a price whose fees or currency alone changed, and only that row", async () => {
    const scraper = new FakeScraper("fees");
    const at = new Date("2026-11-20T03:00:00Z");
    scraper.stations = [
      station("fe-1", 1, { stationType: "ev_charger" }),
      station("fe-2", 2, { stationType: "ev_charger" }),
      station("fe-3", 3),
      station("fe-4", 4),
    ];
    scraper.prices = [
      { stationExternalId: "fe-1", fuelType: "EV", price: 0.59, currency: "EUR", reportedAt: at, evFees: { perMinute: 0.1 } },
      { stationExternalId: "fe-2", fuelType: "EV", price: 0.59, currency: "EUR", reportedAt: at, evFees: { perMinute: 0.1 } },
      { stationExternalId: "fe-3", fuelType: "B7", price: 1.5, currency: "EUR", reportedAt: at },
      { stationExternalId: "fe-4", fuelType: "B7", price: 1.5, currency: "EUR", reportedAt: at },
    ];
    await scraper.run();
    const ids = await client.query<{ key: string; id: string }>(
      `SELECT s.external_id AS key, fp.id::text FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
       WHERE fp.source = 'fees'`,
    );
    const id = new Map(ids.rows.map((r) => [r.key, r.id]));

    // Same price and time; only fe-1's fee and fe-3's currency differ.
    scraper.prices = scraper.prices.map((p) =>
      p.stationExternalId === "fe-1"
        ? { ...p, evFees: { perMinute: 0.2 } }
        : p.stationExternalId === "fe-3"
          ? { ...p, currency: "CHF" }
          : p,
    );
    const before = await rowVersions("fuel_prices");
    await scraper.run();
    const diff = changedRows(before, await rowVersions("fuel_prices"));
    expect(diff.removed).toEqual([]);
    expect(diff.written.sort()).toEqual([id.get("fe-1"), id.get("fe-3")].sort());
    const stored = await client.query<{ key: string; currency: string; fees: unknown }>(
      `SELECT s.external_id AS key, fp.currency, fp.ev_fees AS fees FROM fuel_prices fp
       JOIN stations s ON s.id = fp.station_id WHERE fp.source = 'fees' ORDER BY 1`,
    );
    expect(stored.rows).toEqual([
      { key: "fe-1", currency: "EUR", fees: { perMinute: 0.2 } },
      { key: "fe-2", currency: "EUR", fees: { perMinute: 0.1 } },
      { key: "fe-3", currency: "CHF", fees: null },
      { key: "fe-4", currency: "EUR", fees: null },
    ]);
  });

  it("deletes a key the source no longer lists and inserts a new one, touching nothing else", async () => {
    const scraper = new FakeScraper("churn");
    const data = fuelSet(20);
    scraper.stations = data.stations.map((s) => ({ ...s, externalId: `ch-${s.externalId}` }));
    scraper.prices = data.prices.map((p) => ({ ...p, stationExternalId: `ch-${p.stationExternalId}` }));
    await scraper.run();

    const fpBefore = await rowVersions("fuel_prices");
    const gone = await client.query<{ id: string }>(
      `SELECT fp.id::text FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
       WHERE s.external_id = 'ch-st-3' AND fp.fuel_type = 'E5'`,
    );
    scraper.prices = [
      ...scraper.prices.filter((p) => !(p.stationExternalId === "ch-st-3" && p.fuelType === "E5")),
      { stationExternalId: "ch-st-3", fuelType: "LPG", price: 0.9, currency: "EUR" },
    ];
    await scraper.run();

    const after = await rowVersions("fuel_prices");
    const diff = changedRows(fpBefore, after);
    expect(diff.removed).toEqual([gone.rows[0].id]);
    expect(diff.written).toHaveLength(1); // the new LPG row
    const lpg = await client.query(
      `SELECT fp.price::text FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
       WHERE s.external_id = 'ch-st-3' AND fp.fuel_type = 'LPG'`,
    );
    expect(lpg.rows).toEqual([{ price: "0.900" }]);
  });

  it("removes a vanished station through the orphan cleanup, and never an unchanged one", async () => {
    const scraper = new FakeScraper("orphan");
    const data = fuelSet(5);
    scraper.stations = data.stations.map((s) => ({ ...s, externalId: `or-${s.externalId}` }));
    scraper.prices = data.prices.map((p) => ({ ...p, stationExternalId: `or-${p.stationExternalId}` }));
    await scraper.run();
    // Age every row, as if the last change was a day ago.
    await client.query(`UPDATE stations SET updated_at = now() - interval '1 day' WHERE external_id LIKE 'or-%'`);

    scraper.stations = scraper.stations.filter((s) => s.externalId !== "or-st-4");
    scraper.prices = scraper.prices.filter((p) => p.stationExternalId !== "or-st-4");
    await scraper.run();

    const left = await client.query<{ external_id: string }>(
      `SELECT external_id FROM stations WHERE external_id LIKE 'or-%' ORDER BY 1`,
    );
    expect(left.rows.map((r) => r.external_id)).toEqual(["or-st-0", "or-st-1", "or-st-2", "or-st-3"]);
  });

  it("keeps a listed station with no price when the source asks for it, and still removes an unlisted one", async () => {
    class KeepScraper extends FakeScraper {
      protected readonly keepListedStations = true;
    }
    const scraper = new KeepScraper("keep");
    const data = fuelSet(4);
    scraper.stations = data.stations.map((s) => ({ ...s, externalId: `kp-${s.externalId}` }));
    scraper.prices = data.prices.map((p) => ({ ...p, stationExternalId: `kp-${p.stationExternalId}` }));
    await scraper.run();
    const before = await client.query<{ external_id: string; id: string }>(
      `SELECT external_id, id FROM stations WHERE external_id = 'kp-st-1'`,
    );

    // kp-st-1 is still listed but lost its prices; kp-st-3 is gone from the list.
    scraper.stations = scraper.stations.filter((s) => s.externalId !== "kp-st-3");
    scraper.prices = scraper.prices.filter(
      (p) => p.stationExternalId !== "kp-st-1" && p.stationExternalId !== "kp-st-3",
    );
    await scraper.run();

    const left = await client.query<{ external_id: string; id: string }>(
      `SELECT external_id, id FROM stations WHERE external_id LIKE 'kp-%' ORDER BY 1`,
    );
    expect(left.rows.map((r) => r.external_id)).toEqual(["kp-st-0", "kp-st-1", "kp-st-2"]);
    // Same row, not a re-created one.
    expect(left.rows[1].id).toBe(before.rows[0].id);

    // Without the opt-in the same run deletes the priceless station.
    const plain = new FakeScraper("keep");
    plain.stations = scraper.stations;
    plain.prices = scraper.prices;
    await plain.run();
    const after = await client.query<{ external_id: string }>(
      `SELECT external_id FROM stations WHERE external_id LIKE 'kp-%' ORDER BY 1`,
    );
    expect(after.rows.map((r) => r.external_id)).toEqual(["kp-st-0", "kp-st-2"]);
  });

  it("rewrites a station only when its content or position changed", async () => {
    const scraper = new FakeScraper("moves");
    const data = fuelSet(4);
    scraper.stations = data.stations.map((s) => ({ ...s, externalId: `mv-${s.externalId}` }));
    scraper.prices = data.prices.map((p) => ({ ...p, stationExternalId: `mv-${p.stationExternalId}` }));
    await scraper.run();
    await client.query(`UPDATE stations SET updated_at = '2026-01-01T00:00:00Z' WHERE external_id LIKE 'mv-%'`);

    scraper.stations = scraper.stations.map((s) =>
      s.externalId === "mv-st-1"
        ? { ...s, name: "Renamed" }
        : s.externalId === "mv-st-2"
          ? { ...s, latitude: s.latitude + 1e-7 }
          : s,
    );
    await scraper.run();

    const rows = await client.query<{ external_id: string; moved: boolean; name: string }>(
      `SELECT external_id, updated_at > '2026-01-01T00:00:00Z' AS moved, name FROM stations
       WHERE external_id LIKE 'mv-%' ORDER BY 1`,
    );
    expect(rows.rows.map((r) => [r.external_id, r.moved])).toEqual([
      ["mv-st-0", false],
      ["mv-st-1", true],
      ["mv-st-2", true],
      ["mv-st-3", false],
    ]);
    expect(rows.rows[1].name).toBe("Renamed");
  });

  it("does not rewrite a station without coordinates on every run", async () => {
    const params = ["nogeo-1", COUNTRY, "No geo", null, "Street", "City", null, "fuel", null, null];
    const first = await client.query(stationUpsertSql(1, false), params);
    const second = await client.query(stationUpsertSql(1, false), params);
    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0);
  });

  it("keeps an upstream-dated source on its own times, and stores fees as a jsonb object", async () => {
    const scraper = new FakeScraper("dated");
    const at = new Date("2026-11-20T03:00:00Z");
    scraper.stations = [station("dt-1", 1, { stationType: "ev_charger", maxPowerKw: 150 })];
    scraper.prices = [
      { stationExternalId: "dt-1", fuelType: "EV", price: 0.59, currency: "EUR", reportedAt: at, evFees: { perMinute: 0.1, afterMin: 60 } },
    ];
    await scraper.run();
    expect(await marker("dated")).toBeNull();
    const stored = await client.query<{ t: string }>(`SELECT jsonb_typeof(ev_fees) AS t FROM fuel_prices WHERE source = 'dated'`);
    expect(stored.rows).toEqual([{ t: "object" }]);
    expect((await shown("dated"))[0].shown.toISOString()).toBe(at.toISOString());

    // Same feed again, fee keys in another order: nothing to write.
    scraper.prices = [{ ...scraper.prices[0], evFees: { afterMin: 60, perMinute: 0.1 } }];
    const before = await rowVersions("fuel_prices");
    await scraper.run();
    expect(changedRows(before, await rowVersions("fuel_prices"))).toEqual({ written: [], removed: [] });

    // The feed refreshed: the row takes the new upstream time.
    const later = new Date("2026-11-21T03:00:00Z");
    scraper.prices = [{ ...scraper.prices[0], reportedAt: later }];
    await scraper.run();
    expect((await shown("dated"))[0].shown.toISOString()).toBe(later.toISOString());
    expect(await marker("dated")).toBeNull();
  });

  it("dates the undated rows of a mixed run by the run, as before", async () => {
    const scraper = new FakeScraper("mixed");
    const at = new Date("2026-11-20T03:00:00Z");
    scraper.stations = [station("mx-1", 1)];
    scraper.prices = [
      { stationExternalId: "mx-1", fuelType: "B7", price: 1.5, currency: "EUR", reportedAt: at },
      { stationExternalId: "mx-1", fuelType: "E5", price: 1.6, currency: "EUR" },
    ];
    await scraper.run();
    await client.query(`UPDATE fuel_prices SET reported_at = '2026-01-01T00:00:00Z' WHERE source = 'mixed' AND fuel_type = 'E5'`);
    await scraper.run();
    expect(await marker("mixed")).toBeNull();
    const view = await shown("mixed");
    expect(view[0].shown.toISOString()).toBe(at.toISOString()); // B7, dated upstream
    // E5, undated: rewritten with this run's time, as before this change.
    expect(view[1].shown.getTime()).toBeGreaterThan(new Date("2026-01-02T00:00:00Z").getTime());
  });

  it("sweeps only the charger the run no longer lists, even when every updated_at is old", async () => {
    const scraper = new FakeEvScraper("fake_ev");
    scraper.stations = Array.from({ length: 12 }, (_, i) => station(`fev-${i}`, i, { stationType: "ev_charger" }));
    await scraper.run();
    // Unchanged chargers keep an old updated_at now. The old sweep deleted
    // every own row older than the run; it would delete all 11 live ones.
    await client.query(`UPDATE stations SET updated_at = now() - interval '1 hour' WHERE external_id LIKE 'fev-%'`);
    const oldSweepWouldDelete = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stations
       WHERE country = $1 AND station_type = 'ev_charger' AND external_id LIKE 'fev-%'
         AND updated_at < NOW() - make_interval(secs => 300)`,
      [COUNTRY],
    );
    expect(oldSweepWouldDelete.rows[0].n).toBe(12);

    scraper.stations = scraper.stations.filter((s) => s.externalId !== "fev-5");
    const result = await scraper.run();
    expect(result.errors).toEqual([]);
    const left = await client.query<{ external_id: string }>(
      `SELECT external_id FROM stations WHERE external_id LIKE 'fev-%'`,
    );
    expect(left.rows).toHaveLength(11);
    expect(left.rows.map((r) => r.external_id)).not.toContain("fev-5");

    // A degraded fetch below the floor deletes nothing.
    scraper.floor = 5;
    scraper.stations = scraper.stations.slice(0, 2);
    await scraper.run();
    const still = await client.query(`SELECT count(*)::int AS n FROM stations WHERE external_id LIKE 'fev-%'`);
    expect(still.rows[0].n).toBe(11);
  });

  it("never sweeps a charger an overlapping run of the same source just wrote", async () => {
    const scraper = new FakeEvScraper("fake_ev_overlap");
    scraper.stations = Array.from({ length: 3 }, (_, i) => station(`fev-ov-${i}`, 100 + i, { stationType: "ev_charger" }));
    // Another run lists a charger this run's list does not hold, and writes it.
    scraper.beforeSweep = async () => {
      await client.query(
        `INSERT INTO stations (external_id, country, name, address, city, station_type, geom, updated_at)
         VALUES ('fev-ov-new', $1, 'New', 'Street', 'City', 'ev_charger', ST_SetSRID(ST_MakePoint(-3, 40), 4326), now())`,
        [COUNTRY],
      );
    };
    const result = await scraper.run();
    expect(result.errors).toEqual([]);
    const row = await client.query(`SELECT count(*)::int AS n FROM stations WHERE external_id = 'fev-ov-new'`);
    expect(row.rows[0].n).toBe(1);
  });

  it("serialises two concurrent runs of one source, leaving one row per key", async () => {
    const make = () => {
      const s = new FakeScraper("race");
      const data = fuelSet(300);
      s.stations = data.stations.map((x) => ({ ...x, externalId: `rc-${x.externalId}` }));
      s.prices = data.prices.map((p) => ({ ...p, stationExternalId: `rc-${p.stationExternalId}` }));
      return s;
    };
    const [a, b] = await Promise.all([make().run(), make().run()]);
    expect(a.errors).toEqual([]);
    expect(b.errors).toEqual([]);
    const dup = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM fuel_prices WHERE source = 'race'
       GROUP BY station_id, fuel_type HAVING count(*) > 1) t`,
    );
    expect(dup.rows[0].n).toBe(0);
    const total = await client.query(`SELECT count(*)::int AS n FROM fuel_prices WHERE source = 'race'`);
    expect(total.rows[0].n).toBe(600);
  });

  it("survives a rollback to the previous release's delete-and-insert, and a return to this one", async () => {
    const scraper = new FakeScraper("rollback");
    const data = fuelSet(10);
    scraper.stations = data.stations.map((s) => ({ ...s, externalId: `rb-${s.externalId}` }));
    scraper.prices = data.prices.map((p) => ({ ...p, stationExternalId: `rb-${p.stationExternalId}` }));
    await scraper.run();

    // The previous release's price write, on the new schema.
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM fuel_prices WHERE source = 'rollback' AND station_id IN (SELECT id FROM stations WHERE country = $1)`,
      [COUNTRY],
    );
    await client.query(
      `INSERT INTO fuel_prices (station_id, fuel_type, price, currency, reported_at, source)
       SELECT id, 'B7', 1.777, 'EUR', NOW(), 'rollback' FROM stations WHERE external_id LIKE 'rb-%'`,
    );
    await client.query("COMMIT");
    const view = await shown("rollback");
    expect(view).toHaveLength(10);
    expect(view.every((r) => r.price === "1.777")).toBe(true);

    // Back on this release: one run restores the source's own set.
    await scraper.run();
    const back = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM fuel_prices WHERE source = 'rollback'`);
    expect(back.rows[0].n).toBe(20);
  });
});
