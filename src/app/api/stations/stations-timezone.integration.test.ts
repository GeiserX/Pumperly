import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

// Drives the real GET handler against PostGIS whose default TimeZone is not
// UTC. The pg adapter reads a timestamptz as text and replaces its offset with
// +00:00, so a session in Europe/Madrid (+01 in winter) shifted every
// reportedAt one hour into the future, and the card said "Updated just now"
// for an hour after each scrape.
const hasDocker = process.env.SKIP_INTEGRATION !== "1";
const d = hasDocker ? describe : describe.skip;

const REPORTED_AT = "2026-01-15T10:00:00.000Z";
const RUN_AT = "2026-11-20T08:00:00.000Z";

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/stations");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url };
}

d("stations GET handler with a non-UTC database TimeZone (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let GET: (req: unknown) => Promise<Response>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgis/postgis:17-3.4").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query(`ALTER DATABASE "${container.getDatabase()}" SET timezone TO 'Europe/Madrid'`);
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis");
    await client.query(`
      CREATE TABLE stations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        external_id VARCHAR NOT NULL,
        country VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        brand VARCHAR,
        address TEXT NOT NULL,
        city VARCHAR NOT NULL,
        geom geometry(Point, 4326) NOT NULL,
        station_type VARCHAR NOT NULL DEFAULT 'fuel',
        max_power_kw DECIMAL
      )
    `);
    await client.query(`
      CREATE TABLE fuel_prices (
        id BIGSERIAL PRIMARY KEY,
        station_id UUID NOT NULL REFERENCES stations(id),
        fuel_type VARCHAR NOT NULL,
        price DECIMAL(6,3) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
        reported_at TIMESTAMPTZ,
        source VARCHAR(50) NOT NULL DEFAULT 'test',
        ev_fees JSONB
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

    const row = await client.query<{ id: string }>(
      `INSERT INTO stations (external_id, country, name, address, city, geom)
       VALUES ('t-1', 'ES', 'Station A', 'Test 1', 'Test City', ST_SetSRID(ST_MakePoint(-3.70, 40.41), 4326))
       RETURNING id`,
    );
    const stationId = row.rows[0].id;
    await client.query(
      `INSERT INTO fuel_prices (station_id, fuel_type, price, reported_at, source) VALUES ($1, 'E5', 1.5, $2::timestamptz, 'dated')`,
      [stationId, REPORTED_AT],
    );
    // A marker for the dated source too: an upstream date wins over it.
    await client.query(`INSERT INTO scrape_runs VALUES ('ES', 'dated', $1::timestamptz)`, [RUN_AT]);

    // Undated prices: dated by their source's last successful run, or not at
    // all when the source has never finished one.
    for (const [ext, name, source] of [
      ["t-2", "Station B", "marked"],
      ["t-3", "Station C", "unmarked"],
    ]) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO stations (external_id, country, name, address, city, geom)
         VALUES ($1, 'ES', $2, 'Test 2', 'Test City', ST_SetSRID(ST_MakePoint(-3.71, 40.42), 4326))
         RETURNING id`,
        [ext, name],
      );
      await client.query(`INSERT INTO fuel_prices (station_id, fuel_type, price, source) VALUES ($1, 'E5', 1.6, $2)`, [
        r.rows[0].id,
        source,
      ]);
    }
    await client.query(`INSERT INTO scrape_runs VALUES ('ES', 'marked', $1::timestamptz)`, [RUN_AT]);
    // Same source name in another country: must not date Spain's rows.
    await client.query(`INSERT INTO scrape_runs VALUES ('PT', 'unmarked', $1::timestamptz)`, [RUN_AT]);

    process.env.DATABASE_URL = container.getConnectionUri();
    delete (globalThis as { prisma?: unknown }).prisma;
    vi.resetModules();
    const mod = await import("./route");
    GET = mod.GET as unknown as (req: unknown) => Promise<Response>;
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("returns reportedAt as the stored instant, not shifted by the session offset", async () => {
    const res = await GET(makeRequest({ bbox: "-3.75,40.38,-3.65,40.45", fuel: "E5" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      features: Array<{ properties: { name: string; reportedAt?: string } }>;
    };

    const byName = Object.fromEntries(body.features.map((f) => [f.properties.name, f.properties.reportedAt]));
    expect(byName["Station A"]).toBe(REPORTED_AT);
  });

  it("dates an undated price by its source's last successful run in that country", async () => {
    const res = await GET(makeRequest({ bbox: "-3.75,40.38,-3.65,40.45", fuel: "E5" }));
    const body = (await res.json()) as {
      features: Array<{ properties: { name: string; reportedAt?: string } }>;
    };

    expect(body.features).toHaveLength(3);
    const byName = Object.fromEntries(body.features.map((f) => [f.properties.name, f.properties.reportedAt]));
    expect(byName).toEqual({ "Station A": REPORTED_AT, "Station B": RUN_AT, "Station C": undefined });
  });
});
