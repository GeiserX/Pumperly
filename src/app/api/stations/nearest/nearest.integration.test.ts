import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";

// Drives the real GET handler against PostGIS. At 52° N a degree of longitude
// is only ~68 km, so a query that measures in planar degrees overstates every
// east-west distance by ~1.64x: it ranks a station 0.8 km east behind one
// 1.0 km north, and drops a station 9 km east from a 10 km radius.
const hasDocker = process.env.SKIP_INTEGRATION !== "1";
const d = hasDocker ? describe : describe.skip;

const ORIGIN = { lat: 52.37, lon: 4.89 };
const KM_PER_DEG_LON = 111.32 * Math.cos((ORIGIN.lat * Math.PI) / 180);

const STATIONS = [
  { name: "East 0.8 km", lon: ORIGIN.lon + 0.8 / KM_PER_DEG_LON, lat: ORIGIN.lat, km: 0.8 },
  { name: "North 1.0 km", lon: ORIGIN.lon, lat: ORIGIN.lat + 0.009, km: 1.0 },
  { name: "East 9 km", lon: ORIGIN.lon + 9 / KM_PER_DEG_LON, lat: ORIGIN.lat, km: 9 },
  { name: "North 11 km", lon: ORIGIN.lon, lat: ORIGIN.lat + 0.099, km: 11 },
];

function makeRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/stations/nearest");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { nextUrl: url };
}

d("stations/nearest GET handler against PostGIS (integration)", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let GET: (req: unknown) => Promise<Response>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgis/postgis:17-3.4").start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
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
    await client.query("CREATE INDEX stations_geom_geography_idx ON stations USING GIST ((geom::geography))");
    await client.query(`
      CREATE TABLE fuel_prices (
        id BIGSERIAL PRIMARY KEY,
        station_id UUID NOT NULL REFERENCES stations(id),
        fuel_type VARCHAR NOT NULL,
        price DECIMAL(6,3) NOT NULL,
        currency VARCHAR(3) NOT NULL DEFAULT 'EUR',
        reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ev_fees JSONB
      )
    `);

    for (const [i, s] of STATIONS.entries()) {
      const row = await client.query<{ id: string }>(
        `INSERT INTO stations (external_id, country, name, address, city, geom)
         VALUES ($1, 'NL', $2, 'Test 1', 'Amsterdam', ST_SetSRID(ST_MakePoint($3, $4), 4326))
         RETURNING id`,
        [`t-${i}`, s.name, s.lon, s.lat],
      );
      await client.query(
        `INSERT INTO fuel_prices (station_id, fuel_type, price) VALUES ($1, 'E10', 2.0)`,
        [row.rows[0].id],
      );
    }

    process.env.DATABASE_URL = container.getConnectionUri();
    vi.resetModules();
    const mod = await import("./route");
    GET = mod.GET as unknown as (req: unknown) => Promise<Response>;
  });

  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  it("ranks and filters by true ground distance", async () => {
    const res = await GET(
      makeRequest({ lat: String(ORIGIN.lat), lon: String(ORIGIN.lon), radius_km: "10", fuel: "E10", limit: "10" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      features: Array<{ properties: { name: string; distanceKm: number } }>;
    };

    expect(body.features.map((f) => f.properties.name)).toEqual(["East 0.8 km", "North 1.0 km", "East 9 km"]);
    for (const f of body.features) {
      const want = STATIONS.find((s) => s.name === f.properties.name)!.km;
      expect(Math.abs(f.properties.distanceKm - want) / want).toBeLessThan(0.02);
    }
  });
});
