import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getConfig, COUNTRIES } from "@/lib/config";

interface CountStats {
  country: string;
  stations: number;
  prices: number;
  last_update: Date | null;
}

// Stations per country come from stations alone, and prices per country from a
// plain COUNT over the join. The old COUNT(DISTINCT s.id) over the LEFT JOIN
// sorted every price row by (country, id) and spilled that sort to disk on
// each call. The same numbers come out of two hash aggregates with no sort.
// A price's age is GREATEST(reported_at, confirmed_at): runs write only the
// prices that changed, and price_sources records when each source last
// confirmed the rest.
const STATS_SQL = `
  WITH st AS (
    SELECT country, COUNT(*)::int AS stations
    FROM stations
    GROUP BY country
  ),
  pr AS (
    SELECT s.country, COUNT(*)::int AS prices, MAX(GREATEST(fp.reported_at, ps.confirmed_at)) AS last_update
    FROM fuel_prices fp
    JOIN stations s ON s.id = fp.station_id
    LEFT JOIN price_sources ps ON ps.country = s.country AND ps.source = fp.source
    GROUP BY s.country
  )
  SELECT st.country, st.stations, COALESCE(pr.prices, 0)::int AS prices, pr.last_update
  FROM st
  LEFT JOIN pr ON pr.country = st.country
  ORDER BY st.stations DESC, st.country
`;

// The join hashes every station (about 25 MB for 384k stations). Postgres's
// default work_mem of 4 MB splits that hash into batches on disk, so give this
// one query more room. SET LOCAL ends with the transaction.
const STATS_WORK_MEM = "SET LOCAL work_mem = '32MB'";

// The route already tells caches to keep the answer for 300 s, but Cloudflare
// does not cache /api/* JSON, so every poll reached Postgres. Keep the rows in
// the process for the same 300 s.
const STATS_CACHE_TTL_MS = 300_000;

// `at` is when the rows arrived. It stays null while the query runs, so a
// slow query is shared however long it takes.
let cached: { at: number | null; rows: Promise<CountStats[]> } | null = null;

async function queryStats(): Promise<CountStats[]> {
  const [, rows] = await prisma.$transaction([
    prisma.$executeRawUnsafe(STATS_WORK_MEM),
    prisma.$queryRawUnsafe<CountStats[]>(STATS_SQL),
  ]);
  return rows;
}

function loadStats(): Promise<CountStats[]> {
  if (cached && (cached.at === null || Date.now() - cached.at < STATS_CACHE_TTL_MS)) {
    return cached.rows;
  }
  // Share one query between calls that arrive while it runs. A failure is
  // not kept, so the next call tries again.
  const rows = queryStats();
  const entry: { at: number | null; rows: Promise<CountStats[]> } = { at: null, rows };
  cached = entry;
  rows.then(
    () => {
      entry.at = Date.now();
    },
    () => {
      if (cached === entry) cached = null;
    },
  );
  return rows;
}

export async function GET() {
  const config = getConfig();

  try {
    const rows = await loadStats();

    const countries = rows.map((r) => ({
      code: r.country,
      name: COUNTRIES[r.country]?.name ?? r.country,
      stations: r.stations,
      prices: r.prices,
      lastUpdate: r.last_update ? new Date(r.last_update).toISOString() : null,
    }));

    const totals = {
      stations: countries.reduce((sum, c) => sum + c.stations, 0),
      prices: countries.reduce((sum, c) => sum + c.prices, 0),
    };

    return NextResponse.json({
      totals,
      countries,
      config: {
        defaultCountry: config.defaultCountry,
        enabledCountries: config.enabledCountries,
        defaultFuel: config.defaultFuel,
        center: config.center,
        zoom: config.zoom,
      },
    }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  } catch (err) {
    console.error("Failed to query stats:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
