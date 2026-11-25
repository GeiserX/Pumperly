import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";

// Drives the real BaseScraper.run() (Prisma pg adapter, jsonb parameters and
// all) against PostGIS built from the shipped migrations. The point of the
// pipeline is that a run whose data did not change writes nothing: every
// assertion of that is checked against the rows' xmin/ctid (a rewritten row
// gets a new one) and the WAL position, and each is shown to go red against
// the old rewrite-everything SQL.
const hasDocker = process.env.SKIP_INTEGRATION !== "1";
const d = hasDocker ? describe : describe.skip;

const MIGRATIONS = resolve("prisma/migrations");
const MIGRATE = resolve("docker/migrate.mjs");

function migrate(url: string, dir = MIGRATIONS): string {
  return execFileSync(process.execPath, [MIGRATE], {
    env: { ...process.env, DATABASE_URL: url, MIGRATIONS_DIR: dir },
    encoding: "utf8",
  });
}

class StubScraper extends BaseScraper {
  stations: RawStation[] = [];
  prices: RawFuelPrice[] = [];
  constructor(
    readonly country: string,
    readonly source: string,
  ) {
    super();
  }
  async fetch() {
    return { stations: this.stations, prices: this.prices };
  }
  /** The protected EV sweep, for the sweep tests. */
  sweep(ownPrefix: string, retirePrefixes: string[], minStations: number) {
    return this.sweepEvRows({ ownPrefix, retirePrefixes, minStations, label: "the stub" });
  }
}

function station(id: string, i: number, type: RawStation["stationType"] = "fuel"): RawStation {
  return {
    externalId: id,
    name: `Station ${i}`,
    brand: i % 3 === 0 ? null : `Brand ${i % 7}`,
    address: `Via ${i}`,
    city: `City ${i % 50}`,
    province: i % 5 === 0 ? null : "PV",
    // Doubles with long expansions, so the round trip through JSON is tested.
    latitude: 40 + i * 0.000137 + 1e-9,
    longitude: 9 + i * 0.000173 + 3e-10,
    stationType: type,
    ...(type === "fuel" ? {} : { maxPowerKw: 11 + (i % 300) }),
  };
}

const FUELS = ["E5", "B7", "LPG"] as const;

/** 5,000 stations with 3 prices each, the size of a mid-size country. */
function country(n = 5000) {
  const stations = Array.from({ length: n }, (_, i) => station(`it-${i}`, i));
  const prices: RawFuelPrice[] = stations.flatMap((s, i) =>
    FUELS.map((fuelType, f) => ({
      stationExternalId: s.externalId,
      fuelType,
      price: 1.5 + ((i * 7 + f) % 400) / 1000,
      currency: "EUR",
    })),
  );
  return { stations, prices };
}

d("BaseScraper write-on-change against PostGIS (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  /** id -> xmin/ctid of every row of a country in both tables. */
  async function versions(cc: string) {
    const rows = await client.query<{ k: string; v: string }>(
      `SELECT 's:' || id AS k, xmin::text || ctid::text AS v FROM stations WHERE country = $1
       UNION ALL
       SELECT 'p:' || fp.id, fp.xmin::text || fp.ctid::text
       FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id WHERE s.country = $1`,
      [cc],
    );
    return new Map(rows.rows.map((r) => [r.k, r.v]));
  }

  function changedKeys(before: Map<string, string>, after: Map<string, string>) {
    const keys = new Set([...before.keys(), ...after.keys()]);
    return [...keys].filter((k) => before.get(k) !== after.get(k));
  }

  /** WAL bytes written by `fn`, after a checkpoint so first touches count. */
  async function walOf(fn: () => Promise<unknown>) {
    await client.query("CHECKPOINT");
    const a = await client.query<{ lsn: string }>("SELECT pg_current_wal_insert_lsn()::text AS lsn");
    await fn();
    const b = await client.query<{ bytes: string }>(
      "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)::text AS bytes",
      [a.rows[0].lsn],
    );
    return Number(b.rows[0].bytes);
  }

  async function marker(cc: string, source: string) {
    const r = await client.query<{ at: Date }>(
      "SELECT last_success_at AS at FROM scrape_runs WHERE country = $1 AND source = $2",
      [cc, source],
    );
    return r.rows[0]?.at ?? null;
  }

  /** The SQL every run used before: rewrite every station, replace every price. */
  async function oldStyleRun(cc: string, source: string, data: { stations: RawStation[]; prices: RawFuelPrice[] }) {
    const st = data.stations.map((s) => ({
      external_id: s.externalId, name: s.name, brand: s.brand, address: s.address, city: s.city,
      province: s.province, station_type: s.stationType, lon: s.longitude, lat: s.latitude,
    }));
    await client.query(
      `INSERT INTO stations (external_id, country, name, brand, address, city, province, station_type, geom, created_at, updated_at)
       SELECT external_id, $2, name, brand, address, city, province, station_type,
              ST_SetSRID(ST_MakePoint(lon, lat), 4326), NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS t(external_id text, name text, brand text, address text, city text,
                                                province text, station_type text, lon float8, lat float8)
       ON CONFLICT (external_id, country) DO UPDATE SET
         name = EXCLUDED.name, brand = EXCLUDED.brand, address = EXCLUDED.address, city = EXCLUDED.city,
         province = EXCLUDED.province, station_type = EXCLUDED.station_type, geom = EXCLUDED.geom,
         updated_at = NOW()`,
      [JSON.stringify(st), cc],
    );
    const pr = data.prices.map((p) => ({
      external_id: p.stationExternalId, fuel_type: p.fuelType, price: p.price, currency: p.currency,
    }));
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM fuel_prices WHERE source = $1 AND station_id IN (SELECT id FROM stations WHERE country = $2)`,
      [source, cc],
    );
    await client.query(
      `INSERT INTO fuel_prices (station_id, fuel_type, price, currency, source, reported_at)
       SELECT s.id, t.fuel_type, t.price, t.currency, $3, NOW()
       FROM jsonb_to_recordset($1::jsonb) AS t(external_id text, fuel_type text, price numeric, currency text)
       JOIN stations s ON s.external_id = t.external_id AND s.country = $2`,
      [JSON.stringify(pr), cc, source],
    );
    await client.query("COMMIT");
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgis/postgis:17-3.4").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    // Background vacuums would add WAL inside the measured windows.
    await client.query("ALTER SYSTEM SET autovacuum = off");
    await client.query("SELECT pg_reload_conf()");
    migrate(container.getConnectionUri());
    process.env.DATABASE_URL = container.getConnectionUri();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await client?.end();
    await container?.stop();
  });

  it("writes nothing but the run marker when the data did not change", async () => {
    const data = country();
    const scraper = Object.assign(new StubScraper("IT", "stub"), data);

    const first = await scraper.run();
    expect(first.errors).toEqual([]);
    expect(first).toMatchObject({ stationsChanged: 5000, pricesChanged: 15000, pricesRemoved: 0 });
    const firstMarker = await marker("IT", "stub");
    expect(firstMarker).not.toBeNull();
    // Undated prices are stored undated; the marker dates them.
    const undated = await client.query("SELECT count(*)::int AS n FROM fuel_prices WHERE reported_at IS NULL");
    expect(undated.rows[0].n).toBe(15000);

    const before = await versions("IT");
    let second!: Awaited<ReturnType<StubScraper["run"]>>;
    const wal = await walOf(async () => {
      second = await scraper.run();
    });
    const after = await versions("IT");

    expect(second.errors).toEqual([]);
    expect(second).toMatchObject({
      stationsUpserted: 5000,
      pricesUpserted: 15000,
      stationsChanged: 0,
      pricesChanged: 0,
      pricesRemoved: 0,
    });
    expect(changedKeys(before, after)).toEqual([]);
    expect(wal).toBeLessThan(64 * 1024);
    expect((await marker("IT", "stub"))!.getTime()).toBeGreaterThan(firstMarker!.getTime());

    // Control: the old SQL on the same unchanged data rewrites every row and
    // logs megabytes, so both checks above can fail.
    const oldWal = await walOf(() => oldStyleRun("IT", "stub", data));
    const afterOld = await versions("IT");
    expect(changedKeys(after, afterOld).length).toBeGreaterThanOrEqual(20000);
    expect(oldWal).toBeGreaterThan(1024 * 1024);
    console.info(`[write-on-change] unchanged run: ${wal} B of WAL; old SQL on the same data: ${oldWal} B`);
  });

  describe("on a small country", () => {
    const cc = "ZZ";
    const src = "small";
    let scraper: StubScraper;
    const base = () => {
      const stations = [station("a", 1), station("b", 2), station("c", 3)];
      const prices: RawFuelPrice[] = [
        { stationExternalId: "a", fuelType: "E5", price: 1.611, currency: "EUR" },
        { stationExternalId: "a", fuelType: "B7", price: 1.522, currency: "EUR" },
        { stationExternalId: "b", fuelType: "E5", price: 1.633, currency: "EUR" },
        { stationExternalId: "c", fuelType: "E5", price: 1.644, currency: "EUR" },
      ];
      return { stations, prices };
    };
    const priceRow = async (ext: string, fuel: string) =>
      (
        await client.query<{ price: string; reported_at: Date | null; v: string }>(
          `SELECT fp.price::text, fp.reported_at, fp.xmin::text || fp.ctid::text AS v
           FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
           WHERE s.country = $1 AND s.external_id = $2 AND fp.fuel_type = $3 AND fp.source = $4`,
          [cc, ext, fuel, src],
        )
      ).rows;

    beforeAll(async () => {
      scraper = Object.assign(new StubScraper(cc, src), base());
      expect((await scraper.run()).errors).toEqual([]);
    });

    it("writes exactly the one price that changed, and keeps it undated", async () => {
      const before = await versions(cc);
      const data = base();
      data.prices[1] = { ...data.prices[1], price: 1.499 };
      const result = await Object.assign(scraper, data).run();
      const after = await versions(cc);

      expect(result).toMatchObject({ errors: [], stationsChanged: 0, pricesChanged: 1, pricesRemoved: 0 });
      const changed = changedKeys(before, after);
      expect(changed).toHaveLength(1);
      const row = await priceRow("a", "B7");
      expect(row).toEqual([expect.objectContaining({ price: "1.499", reported_at: null })]);
      expect(changed[0]).toMatch(/^p:/);
    });

    it("writes a station whose data changed, and only that one", async () => {
      const before = await versions(cc);
      const data = base();
      data.prices[1] = { ...data.prices[1], price: 1.499 };
      data.stations[1] = { ...data.stations[1], latitude: data.stations[1].latitude + 1e-7 };
      const result = await Object.assign(scraper, data).run();
      const after = await versions(cc);

      expect(result).toMatchObject({ errors: [], stationsChanged: 1, pricesChanged: 0 });
      expect(changedKeys(before, after)).toHaveLength(1);
    });

    it("writes a price whose upstream date changed", async () => {
      const data = base();
      data.prices[1] = { ...data.prices[1], price: 1.499 };
      data.stations[1] = { ...data.stations[1], latitude: data.stations[1].latitude + 1e-7 };
      data.prices[0] = { ...data.prices[0], reportedAt: new Date("2026-11-01T10:00:00Z") };
      expect((await Object.assign(scraper, data).run()).pricesChanged).toBe(1);
      expect((await priceRow("a", "E5"))[0].reported_at?.toISOString()).toBe("2026-11-01T10:00:00.000Z");
      data.prices[0] = { ...data.prices[0], reportedAt: new Date("2026-11-02T10:00:00Z") };
      expect((await Object.assign(scraper, data).run()).pricesChanged).toBe(1);
      expect((await scraper.run()).pricesChanged).toBe(0);
    });

    it("keeps one row for a fuel listed twice, the first emitted, without an error", async () => {
      const data = base();
      data.prices.push({ stationExternalId: "d", fuelType: "E5", price: 1.701, currency: "EUR" });
      data.prices.push({ stationExternalId: "d", fuelType: "E5", price: 1.801, currency: "EUR" });
      data.stations.push(station("d", 4));
      const result = await Object.assign(scraper, data).run();

      expect(result.errors).toEqual([]);
      expect(await priceRow("d", "E5")).toEqual([expect.objectContaining({ price: "1.701" })]);
    });

    it("removes a price the upstream dropped, and the station it leaves without prices", async () => {
      const data = base();
      data.stations.push(station("d", 4));
      data.prices.push({ stationExternalId: "d", fuelType: "E5", price: 1.701, currency: "EUR" });
      await Object.assign(scraper, data).run();

      // c's only price vanishes; c is still listed but has no valid price, so
      // the run drops it and the orphan cleanup deletes it, as before.
      data.prices = data.prices.filter((p) => p.stationExternalId !== "c");
      const result = await Object.assign(scraper, data).run();

      expect(result).toMatchObject({ errors: [], pricesRemoved: 1 });
      const left = await client.query("SELECT external_id FROM stations WHERE country = $1 ORDER BY 1", [cc]);
      expect(left.rows.map((r) => r.external_id)).toEqual(["a", "b", "d"]);
    });

    it("inserts a new station and its price", async () => {
      const data = base();
      data.stations.push(station("d", 4), station("e", 5));
      data.prices.push({ stationExternalId: "d", fuelType: "E5", price: 1.701, currency: "EUR" });
      data.prices.push({ stationExternalId: "e", fuelType: "B7", price: 1.555, currency: "EUR" });
      const result = await Object.assign(scraper, data).run();

      expect(result.errors).toEqual([]);
      expect(result.pricesChanged).toBeGreaterThanOrEqual(2); // e's, plus c's back
      expect(await priceRow("e", "B7")).toEqual([expect.objectContaining({ price: "1.555", reported_at: null })]);
    });

    it("skips the orphan cleanup when a station batch fails, as before", async () => {
      const data = base();
      data.stations.push(station("d", 4), station("e", 5));
      data.prices.push({ stationExternalId: "d", fuelType: "E5", price: 1.701, currency: "EUR" });
      // e loses its only price; a broken station fails the (only) batch.
      data.stations.push({ ...station("bad", 9), name: null as unknown as string });
      data.prices.push({ stationExternalId: "bad", fuelType: "E5", price: 1.7, currency: "EUR" });
      data.stations = data.stations.filter((s) => s.externalId !== "e");
      const result = await Object.assign(scraper, data).run();

      expect(result.errors.some((e) => e.startsWith("Station batch"))).toBe(true);
      expect(result.errors.some((e) => e.startsWith("Skipped orphan cleanup"))).toBe(true);
      const e = await client.query("SELECT 1 FROM stations WHERE country = $1 AND external_id = 'e'", [cc]);
      expect(e.rowCount).toBe(1);
    });

    it("writes nothing and keeps the marker on an empty fetch", async () => {
      const before = await versions(cc);
      const at = await marker(cc, src);
      const result = await Object.assign(scraper, { stations: [], prices: [] }).run();

      expect(result.errors[0]).toMatch(/Aborted destructive replace/);
      expect(changedKeys(before, await versions(cc))).toEqual([]);
      expect(await marker(cc, src)).toEqual(at);
    });

    it("keeps prices and the marker when the price transaction fails", async () => {
      const data = base();
      data.stations.push(station("d", 4));
      data.prices.push({ stationExternalId: "d", fuelType: "E5", price: 1.701, currency: "EUR" });
      await Object.assign(scraper, data).run();
      const before = await versions(cc);
      const at = await marker(cc, src);

      data.prices = data.prices.map((p) => ({ ...p, price: p.price + 0.1 }));
      // fuel_type is VARCHAR(20): this row makes the upsert fail mid-transaction.
      data.prices.push({ stationExternalId: "d", fuelType: "X".repeat(21) as never, price: 1.7, currency: "EUR" });
      const result = await Object.assign(scraper, data).run();

      expect(result.errors.some((e) => e.startsWith("Fatal:"))).toBe(true);
      expect(result.pricesChanged).toBe(0);
      expect(changedKeys(before, await versions(cc))).toEqual([]);
      expect(await marker(cc, src)).toEqual(at);
    });
  });

  describe("EV sweep", () => {
    const cc = "DE";
    const chargers = (n: number) => Array.from({ length: n }, (_, i) => station(`bnetza-${i}`, i, "ev_charger"));
    let scraper: StubScraper;

    beforeAll(async () => {
      scraper = Object.assign(new StubScraper(cc, "bnetza"), { stations: chargers(1000), prices: [] });
      expect((await scraper.run()).errors).toEqual([]);
      // Written a day ago, as a previous scheduled run would have.
      await client.query(`UPDATE stations SET updated_at = NOW() - interval '1 day' WHERE country = $1`, [cc]);
      await client.query(
        `INSERT INTO stations (external_id, country, name, address, city, station_type, geom)
         SELECT 'ocm-' || g, $1, 'OCM ' || g, 'x', 'y', 'ev_charger', ST_SetSRID(ST_MakePoint(9, 50), 4326)
         FROM generate_series(1, 25) g`,
        [cc],
      );
    });

    it("deletes nothing when this run listed fewer stations than the floor", async () => {
      const result = await Object.assign(scraper, { stations: chargers(42) }).run();
      expect(result.errors).toEqual([]);
      await scraper.sweep("bnetza-", ["ocm-"], 500);

      const n = await client.query("SELECT count(*)::int AS n FROM stations WHERE country = $1", [cc]);
      expect(n.rows[0].n).toBe(1025);
    });

    it("deletes the chargers the run did not list, retires the old source, and leaves unchanged ones alone", async () => {
      const result = await Object.assign(scraper, { stations: chargers(990) }).run();
      expect(result).toMatchObject({ errors: [], stationsChanged: 0 });

      // Control: the old time-based sweep would have deleted all 990 live,
      // unchanged chargers, because their updated_at no longer moves.
      const oldStale = await client.query(
        `SELECT count(*)::int AS n FROM stations
         WHERE country = $1 AND station_type = 'ev_charger' AND external_id LIKE 'bnetza-%'
           AND updated_at < NOW() - make_interval(secs => $2::float8)`,
        [cc, result.durationMs / 1000 + 300],
      );
      expect(oldStale.rows[0].n).toBe(1000);

      const before = await versions(cc);
      await scraper.sweep("bnetza-", ["ocm-"], 500);
      const after = await versions(cc);

      const left = await client.query<{ external_id: string }>(
        "SELECT external_id FROM stations WHERE country = $1",
        [cc],
      );
      const ids = new Set(left.rows.map((r) => r.external_id));
      expect(ids.size).toBe(990);
      expect([...ids].every((id) => /^bnetza-\d+$/.test(id) && Number(id.slice(7)) < 990)).toBe(true);
      // The 990 survivors were not touched; only deleted rows differ.
      for (const k of changedKeys(before, after)) expect(after.has(k)).toBe(false);
    });
  });
});

d("write_on_change migration (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let oldDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgis/postgis:17-3.4").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    // The migrations before this one: the schema a running instance has today.
    oldDir = mkdtempSync(join(tmpdir(), "pumperly-mig-"));
    for (const name of readdirSync(MIGRATIONS).filter((n) => n < "20261125")) {
      cpSync(join(MIGRATIONS, name), join(oldDir, name), { recursive: true });
    }
    migrate(container.getConnectionUri(), oldDir);
  });

  afterAll(async () => {
    rmSync(oldDir, { recursive: true, force: true });
    await client?.end();
    await container?.stop();
  });

  it("folds duplicates into the row readers showed, then enforces one row per key", async () => {
    const s = await client.query<{ id: string }>(
      `INSERT INTO stations (external_id, country, name, address, city, geom)
       VALUES ('m-1', 'IT', 'M', 'a', 'c', ST_SetSRID(ST_MakePoint(9, 45), 4326)) RETURNING id`,
    );
    const id = s.rows[0].id;
    // E5: three rows, newest date wins. B7: two rows on the same date, the
    // first inserted (lowest id) wins. LPG: a single row is left alone.
    await client.query(
      `INSERT INTO fuel_prices (station_id, fuel_type, price, source, reported_at) VALUES
         ($1, 'E5', 1.1, 'mimit', '2026-11-20T10:00:00Z'),
         ($1, 'E5', 1.2, 'mimit', '2026-11-21T10:00:00Z'),
         ($1, 'E5', 1.3, 'mimit', '2026-11-19T10:00:00Z'),
         ($1, 'B7', 1.4, 'mimit', '2026-11-21T10:00:00Z'),
         ($1, 'B7', 1.5, 'mimit', '2026-11-21T10:00:00Z'),
         ($1, 'LPG', 0.7, 'mimit', '2026-11-21T10:00:00Z'),
         ($1, 'E5', 1.9, 'other', '2026-11-01T10:00:00Z')`,
      [id],
    );

    const out = migrate(container.getConnectionUri());
    expect(out).toMatch(/applying 20261125000000_write_on_change/);

    const rows = await client.query<{ fuel_type: string; source: string; price: string }>(
      "SELECT fuel_type, source, price::text FROM fuel_prices ORDER BY fuel_type, source",
    );
    expect(rows.rows).toEqual([
      { fuel_type: "B7", source: "mimit", price: "1.400" },
      { fuel_type: "E5", source: "mimit", price: "1.200" },
      { fuel_type: "E5", source: "other", price: "1.900" },
      { fuel_type: "LPG", source: "mimit", price: "0.700" },
    ]);

    const idx = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'fuel_prices' ORDER BY 1",
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual(["fuel_prices_pkey", "fuel_prices_station_id_fuel_type_source_key"]);
    const col = await client.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'fuel_prices' AND column_name = 'reported_at'`,
    );
    expect(col.rows[0]).toEqual({ is_nullable: "YES", column_default: null });
    const opts = await client.query<{ reloptions: string[] }>(
      "SELECT reloptions FROM pg_class WHERE relname = 'fuel_prices'",
    );
    expect(opts.rows[0].reloptions).toEqual(["fillfactor=90"]);
    expect((await client.query("SELECT to_regclass('public.scrape_runs') AS t")).rows[0].t).toBe("scrape_runs");

    await expect(
      client.query(`INSERT INTO fuel_prices (station_id, fuel_type, price, source) VALUES ($1, 'E5', 1, 'mimit')`, [id]),
    ).rejects.toThrow(/duplicate key/);

    // Running it again applies nothing.
    expect(migrate(container.getConnectionUri())).toMatch(/0 migration\(s\) applied/);
    // And the SQL itself is safe to run twice, for databases built by hand.
    // One multi-statement query, the way `prisma migrate deploy` sends it.
    const sql = readdirSync(MIGRATIONS).find((n) => n.endsWith("_write_on_change"))!;
    await client.query(readFileSync(join(MIGRATIONS, sql, "migration.sql"), "utf8"));
  });
});
