import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

// Drives the real GET handler against PostGIS and checks that its numbers
// match the query the route used before the rewrite (COUNT(DISTINCT s.id)
// over the LEFT JOIN), including a country whose stations have no prices.
const hasDocker = process.env.SKIP_INTEGRATION !== "1";
const d = hasDocker ? describe : describe.skip;

const OLD_STATS_SQL = `
  SELECT
    s.country,
    COUNT(DISTINCT s.id)::int AS stations,
    COUNT(fp.id)::int AS prices,
    MAX(COALESCE(fp.reported_at, sr.last_success_at)) AS last_update
  FROM stations s
  LEFT JOIN fuel_prices fp ON fp.station_id = s.id
  LEFT JOIN scrape_runs sr ON sr.country = s.country AND sr.source = fp.source
  GROUP BY s.country
  ORDER BY stations DESC, s.country
`;

const PT_RUN_AT = "2026-11-20T08:00:00.000Z";

d("stats GET handler (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let GET: () => Promise<Response>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgis/postgis:17-3.4").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query(`
      CREATE TABLE stations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_id VARCHAR NOT NULL,
        country VARCHAR(2) NOT NULL
      )
    `);
    await client.query(`
      CREATE TABLE fuel_prices (
        id BIGSERIAL PRIMARY KEY,
        station_id UUID NOT NULL REFERENCES stations(id),
        fuel_type VARCHAR NOT NULL,
        reported_at TIMESTAMPTZ,
        source VARCHAR(50) NOT NULL DEFAULT 'test'
      )
    `);
    await client.query(`
      CREATE TABLE scrape_runs (
        country VARCHAR(2) NOT NULL,
        source VARCHAR(50) NOT NULL,
        last_success_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (country, source)
      )
    `);
    // ES: 30 stations, 3 prices each. DE: 50 stations, 1 price on every
    // other one. US: 20 stations, no prices. FR and IT tie on 10 stations.
    const seed: Array<[string, number, number]> = [
      ["ES", 30, 3],
      ["DE", 50, 1],
      ["US", 20, 0],
      ["FR", 10, 2],
      ["IT", 10, 1],
    ];
    for (const [country, stations, pricesEach] of seed) {
      await client.query(
        `INSERT INTO stations (external_id, country)
         SELECT $1 || '-' || g, $1 FROM generate_series(1, $2::int) g`,
        [country, stations],
      );
      if (pricesEach === 0) continue;
      await client.query(
        `INSERT INTO fuel_prices (station_id, fuel_type, reported_at)
         SELECT s.id, 'F' || p, TIMESTAMPTZ '2026-11-01 00:00:00+00' + (p || ' hours')::interval
                + (row_number() OVER (ORDER BY s.external_id) || ' minutes')::interval
         FROM stations s CROSS JOIN generate_series(1, $2::int) p
         WHERE s.country = $1 AND ($1 <> 'DE' OR split_part(s.external_id, '-', 2)::int % 2 = 0)`,
        [country, pricesEach],
      );
    }

    // PT: undated prices from "marked", dated by its run marker, plus one
    // older dated price. An EV-only source with a newer marker and no price
    // rows must not move PT's last update.
    await client.query(
      `INSERT INTO stations (external_id, country) SELECT 'PT-' || g, 'PT' FROM generate_series(1, 5) g`,
    );
    await client.query(
      `INSERT INTO fuel_prices (station_id, fuel_type, source) SELECT id, 'E5', 'marked' FROM stations WHERE country = 'PT'`,
    );
    await client.query(
      `INSERT INTO fuel_prices (station_id, fuel_type, source, reported_at)
       SELECT id, 'B7', 'dated', TIMESTAMPTZ '2026-10-01 00:00:00+00' FROM stations WHERE external_id = 'PT-1'`,
    );
    await client.query(
      `INSERT INTO scrape_runs VALUES ('PT', 'marked', $1::timestamptz), ('PT', 'evonly', '2026-11-24T00:00:00Z')`,
      [PT_RUN_AT],
    );

    process.env.DATABASE_URL = container.getConnectionUri();
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.resetModules();
    const mod = await import("./route");
    GET = mod.GET as unknown as () => Promise<Response>;
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("returns the same per-country numbers as the old COUNT(DISTINCT) query", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totals: { stations: number; prices: number };
      countries: Array<{ code: string; stations: number; prices: number; lastUpdate: string | null }>;
    };

    const old = await client.query<{ country: string; stations: number; prices: number; last_update: Date | null }>(
      OLD_STATS_SQL,
    );
    const expected = old.rows.map((r) => ({
      code: r.country,
      stations: r.stations,
      prices: r.prices,
      lastUpdate: r.last_update ? r.last_update.toISOString() : null,
    }));

    expect(body.countries.map(({ code, stations, prices, lastUpdate }) => ({ code, stations, prices, lastUpdate })))
      .toEqual(expected);
    expect(body.countries.find((c) => c.code === "US")).toMatchObject({ stations: 20, prices: 0, lastUpdate: null });
    expect(body.countries.find((c) => c.code === "DE")).toMatchObject({ stations: 50, prices: 25 });
    expect(body.countries.find((c) => c.code === "PT")).toMatchObject({ stations: 5, prices: 6, lastUpdate: PT_RUN_AT });
    expect(body.totals).toEqual({ stations: 125, prices: 90 + 25 + 20 + 10 + 6 });
  });

  it("leaves work_mem unchanged for the rest of the session", async () => {
    const { prisma } = await import("@/lib/db");
    const rows = await prisma.$queryRawUnsafe<Array<{ work_mem: string }>>("SHOW work_mem");
    expect(rows[0].work_mem).toBe("4MB");
  });
});
