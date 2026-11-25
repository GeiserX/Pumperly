import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Prisma adapter + client at module level
const mockExecuteRawUnsafe = vi.fn();
const mockQueryRawUnsafe = vi.fn();
const mockTransaction = vi.fn();
const mockDisconnect = vi.fn();

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: function PrismaPg() {},
}));

vi.mock("../generated/prisma/client", () => ({
  PrismaClient: function PrismaClient() {
    return {
      $executeRawUnsafe: mockExecuteRawUnsafe,
      $queryRawUnsafe: mockQueryRawUnsafe,
      $transaction: mockTransaction,
      $disconnect: mockDisconnect,
    };
  },
}));

// Concrete test scraper
import {
  BaseScraper,
  bandFor,
  isPlausibleEvPrice,
  maxSanePowerKw,
  sanePowerKw,
  dedupePrices,
  stationUpsertSql,
  PRICE_UPSERT_SQL,
  PRICE_REMOVE_SQL,
  SCRAPE_RUN_SQL,
  type RawStation,
  type RawFuelPrice,
} from "./base";

describe("bandFor (per-currency price bands)", () => {
  it("accepts a plausible HUF price (595)", () => {
    const band = bandFor("HUF");
    expect(595 >= band.min && 595 <= band.max).toBe(true);
  });

  it("rejects an EUR-magnitude HUF price (1.5 — wrong units)", () => {
    const band = bandFor("HUF");
    expect(1.5 >= band.min && 1.5 <= band.max).toBe(false);
  });

  it("accepts a plausible ARS price (2050 — high inflation)", () => {
    const band = bandFor("ARS");
    expect(2050 >= band.min && 2050 <= band.max).toBe(true);
  });

  it("accepts a plausible EUR price (1.65)", () => {
    const band = bandFor("EUR");
    expect(1.65 >= band.min && 1.65 <= band.max).toBe(true);
  });

  it("rejects a HUF-magnitude EUR price (1518 — wrong units)", () => {
    const band = bandFor("EUR");
    expect(1518 >= band.min && 1518 <= band.max).toBe(false);
  });

  it("accepts a cheap Czech LPG price (13.9 CZK)", () => {
    const band = bandFor("CZK");
    expect(13.9 >= band.min && 13.9 <= band.max).toBe(true);
  });

  it("rejects a single-digit garbage CZK price (5)", () => {
    const band = bandFor("CZK");
    expect(5 >= band.min && 5 <= band.max).toBe(false);
  });

  it("falls back to a permissive default band for unknown currencies", () => {
    const band = bandFor("ZZZ");
    expect(band.min).toBe(0.1);
    expect(band.max).toBe(100000);
  });
});

class TestScraper extends BaseScraper {
  readonly country = "XX";
  readonly source = "test_source";

  // Controllable from tests
  mockStations: RawStation[] = [];
  mockPrices: RawFuelPrice[] = [];
  shouldThrow = false;

  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    if (this.shouldThrow) throw new Error("Upstream API failed");
    return { stations: this.mockStations, prices: this.mockPrices };
  }
}

function makeStation(id: string, lat = 40.0, lon = -3.5): RawStation {
  return {
    externalId: id,
    name: `Station ${id}`,
    brand: "TestBrand",
    address: "123 Main St",
    city: "TestCity",
    province: "TP",
    latitude: lat,
    longitude: lon,
    stationType: "fuel",
  };
}

function makePrice(stationId: string, fuel = "B7", price = 1.5, currency = "EUR"): RawFuelPrice {
  return {
    stationExternalId: stationId,
    fuelType: fuel as RawFuelPrice["fuelType"],
    price,
    currency,
  };
}

describe("BaseScraper.run()", () => {
  const ORIG_ENV = process.env;
  let scraper: TestScraper;

  beforeEach(() => {
    scraper = new TestScraper();
    process.env = { ...ORIG_ENV, DATABASE_URL: "postgres://localhost:5432/test" };
    mockExecuteRawUnsafe.mockReset();
    mockQueryRawUnsafe.mockReset();
    mockTransaction.mockReset();
    mockDisconnect.mockReset();

    // Default: station lookup returns matching IDs
    mockQueryRawUnsafe.mockResolvedValue([]);
    // Default: transaction executes the callback
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: mockExecuteRawUnsafe,
      }),
    );
  });

  afterEach(() => {
    process.env = ORIG_ENV;
    vi.restoreAllMocks();
  });

  /** The price rows sent to every upsert chunk, in order. */
  function priceRows(): Array<Record<string, unknown>> {
    return mockExecuteRawUnsafe.mock.calls
      .filter(([sql]) => sql === PRICE_UPSERT_SQL)
      .flatMap(([, rows]) => JSON.parse(rows as string) as Array<Record<string, unknown>>);
  }

  it("aborts the destructive replace when no data is fetched", async () => {
    scraper.mockStations = [];
    scraper.mockPrices = [];

    // Station lookup returns empty
    mockQueryRawUnsafe.mockResolvedValue([]);

    const result = await scraper.run();

    expect(result.country).toBe("XX");
    expect(result.source).toBe("test_source");
    expect(result.stationsUpserted).toBe(0);
    expect(result.pricesUpserted).toBe(0);
    // An empty fetch must NOT wipe a country: the run aborts before the
    // destructive price-replace / orphan-cleanup and records why.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Aborted destructive replace");
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("writes max_power_kw for charger batches", async () => {
    scraper.mockStations = [
      { ...makeStation("s1"), stationType: "ev_charger" },
      { ...makeStation("s2"), stationType: "ev_charger", maxPowerKw: 150 },
    ];
    scraper.mockPrices = [];
    mockQueryRawUnsafe.mockResolvedValue([]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    await scraper.run();

    const stationCall = mockExecuteRawUnsafe.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO stations"),
    );
    expect(stationCall).toBeDefined();
    // One jsonb parameter carries the rows; max_power_kw is null when unset.
    expect(stationCall![0]).toContain("max_power_kw = EXCLUDED.max_power_kw");
    expect(stationCall!.slice(1)).toEqual([expect.any(String), "XX"]);
    const rows = JSON.parse(stationCall![1] as string) as Array<{ max_power_kw: number | null }>;
    expect(rows.map((r) => r.max_power_kw)).toEqual([null, 150]);
  });

  it("upserts stations and prices in full pipeline", async () => {
    scraper.mockStations = [makeStation("s1"), makeStation("s2")];
    scraper.mockPrices = [
      makePrice("s1", "B7", 1.45),
      makePrice("s2", "E5", 1.60),
    ];

    // Station lookup returns matching UUIDs
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
      { id: "uuid-2", external_id: "s2" },
    ]);

    // Orphan cleanup
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);

    // Station upsert
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();

    expect(result.stationsUpserted).toBe(2);
    expect(result.pricesUpserted).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify station upsert SQL was called
    const stationCall = mockExecuteRawUnsafe.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO stations"),
    );
    expect(stationCall).toBeDefined();
    // Fuel-only batch: max_power_kw is left alone.
    expect(stationCall![0]).not.toContain("max_power_kw");
    expect(JSON.parse(stationCall![1] as string)).toHaveLength(2);

    // Verify price insert SQL was called
    const priceCall = mockExecuteRawUnsafe.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO fuel_prices"),
    );
    expect(priceCall).toBeDefined();
  });

  it("filters out invalid EUR prices below min (0.30) and above max (4.00)", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [
      makePrice("s1", "B7", 0.10, "EUR"),  // too low
      makePrice("s1", "E5", 5.50, "EUR"),  // too high
      makePrice("s1", "E10", 1.50, "EUR"), // valid
    ];

    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();

    // Only the valid price should be inserted
    expect(result.pricesUpserted).toBe(1);
  });

  it("uses wider range for non-EUR/GBP/CHF currencies", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [
      makePrice("s1", "B7", 22.50, "MXN"), // valid (< 4000)
      makePrice("s1", "E5", 5000, "MXN"),  // too high (> 4000)
    ];

    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();
    expect(result.pricesUpserted).toBe(1);
  });

  it("allows alt fuel prices (H2, CNG, LNG, ADBLUE) with special range", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [
      makePrice("s1", "CNG" as RawFuelPrice["fuelType"], 1.20, "EUR"), // valid
      makePrice("s1", "ADBLUE" as RawFuelPrice["fuelType"], 0.50, "EUR"), // valid
      makePrice("s1", "H2" as RawFuelPrice["fuelType"], 0.01, "EUR"),  // too low (< 0.05)
      makePrice("s1", "LNG" as RawFuelPrice["fuelType"], 150, "EUR"),  // too high (>= 100)
    ];

    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();
    expect(result.pricesUpserted).toBe(2);
  });

  it("validates EV prices per kWh and writes their fees as JSON", async () => {
    scraper.mockStations = [{ ...makeStation("ev1"), stationType: "ev_charger" }];
    scraper.mockPrices = [
      { ...makePrice("ev1", "EV", 0.79, "EUR"), evFees: { perMinute: 0.24, afterMin: 30 } }, // valid
      makePrice("ev1", "EV", 0.05, "EUR"), // too low (< 0.10), would pass the per-litre alt band
      makePrice("ev1", "EV", 2.5, "EUR"), // too high (> 2.00), would pass the EUR fuel band
    ];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-ev", external_id: "ev1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();
    expect(result.pricesUpserted).toBe(1);

    expect(priceRows()).toEqual([
      expect.objectContaining({ fuel_type: "EV", price: 0.79, ev_fees: { perMinute: 0.24, afterMin: 30 } }),
    ]);
  });

  it("writes a NULL ev_fees for fuel prices", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.5, "EUR")];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-1", external_id: "s1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    await scraper.run();
    expect(priceRows()).toEqual([expect.objectContaining({ fuel_type: "B7", ev_fees: null })]);
  });

  it("writes an upstream reported_at when the price carries one", async () => {
    scraper.mockStations = [{ ...makeStation("ev1"), stationType: "ev_charger" }];
    scraper.mockPrices = [{ ...makePrice("ev1", "EV", 0.79, "EUR"), reportedAt: new Date("2026-10-20T04:00:00Z") }];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-ev", external_id: "ev1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    await scraper.run();
    expect(priceRows()).toEqual([expect.objectContaining({ reported_at: "2026-10-20T04:00:00.000Z" })]);
  });

  it("writes a NULL reported_at for prices without an upstream timestamp", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.5, "EUR")];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-1", external_id: "s1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    await scraper.run();
    // NULL means "dated by this source's last successful run" (scrape_runs).
    expect(priceRows()).toEqual([expect.objectContaining({ reported_at: null })]);
  });

  it("drops fuel stations with no valid prices (keeps EV chargers)", async () => {
    const evStation: RawStation = {
      ...makeStation("ev1"),
      stationType: "ev_charger",
    };
    scraper.mockStations = [makeStation("s1"), evStation];
    // s1 has invalid price, ev1 has no prices (EV charger)
    scraper.mockPrices = [makePrice("s1", "B7", 0.01, "EUR")]; // filtered

    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-ev", external_id: "ev1" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();

    // Only EV charger station should be upserted (s1 dropped, no valid prices)
    expect(result.stationsUpserted).toBe(1);
  });

  it("handles fetch() throwing with fatal error", async () => {
    scraper.shouldThrow = true;

    const result = await scraper.run();

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Fatal: Upstream API failed");
    expect(result.stationsUpserted).toBe(0);
    expect(result.pricesUpserted).toBe(0);
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("records station batch errors without stopping", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.50, "EUR")];

    // Station upsert throws
    mockExecuteRawUnsafe.mockRejectedValueOnce(new Error("DB constraint violation"));

    // Station lookup (still runs)
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);

    const result = await scraper.run();

    expect(result.stationsUpserted).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Station batch");
  });

  it("cleans up orphaned stations and reports count", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.50)];

    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
    ]);
    // Cleanup returns 3 deleted
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(3) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();
    expect(result.errors).toHaveLength(0);
    // The run still completes successfully
    expect(result.stationsUpserted).toBe(1);
  });

  it("handles unresolved prices (station not in DB lookup)", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.50)];

    // Station lookup returns empty — no UUID match
    mockQueryRawUnsafe.mockResolvedValueOnce([]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();

    // Prices can't resolve, so 0 inserted
    expect(result.pricesUpserted).toBe(0);
  });

  it("uses custom PUMPERLY_PRICE_MIN and PUMPERLY_PRICE_MAX env vars", async () => {
    process.env.PUMPERLY_PRICE_MIN = "0.50";
    process.env.PUMPERLY_PRICE_MAX = "3.00";

    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [
      makePrice("s1", "B7", 0.40, "EUR"),  // below custom min
      makePrice("s1", "E5", 3.50, "EUR"),  // above custom max
      makePrice("s1", "E10", 1.50, "EUR"), // valid
    ];

    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();
    expect(result.pricesUpserted).toBe(1);
  });

  it("filters out zero and negative prices", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [
      makePrice("s1", "B7", 0, "EUR"),
      makePrice("s1", "E5", -1.5, "EUR"),
      makePrice("s1", "E10", 1.50, "EUR"),
    ];

    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();
    expect(result.pricesUpserted).toBe(1);
  });

  it("batches large station sets in groups of 500", async () => {
    // Create 600 stations
    const stations = Array.from({ length: 600 }, (_, i) => makeStation(`s${i}`));
    const prices = stations.map((s) => makePrice(s.externalId, "B7", 1.50));
    scraper.mockStations = stations;
    scraper.mockPrices = prices;

    mockQueryRawUnsafe.mockResolvedValueOnce(
      stations.map((s) => ({ id: `uuid-${s.externalId}`, external_id: s.externalId })),
    );
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    const result = await scraper.run();

    // Should have been called at least twice for stations (500 + 100 batches)
    const stationInserts = mockExecuteRawUnsafe.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO stations"),
    );
    expect(stationInserts.length).toBe(2); // 500 + 100

    expect(result.stationsUpserted).toBe(600);
  });

  it("upserts the changed prices, removes the vanished ones and dates the run, in one transaction", async () => {
    scraper.mockStations = [makeStation("s1"), makeStation("s2")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.45), makePrice("s2", "E5", 1.6)];
    mockQueryRawUnsafe.mockResolvedValueOnce([
      { id: "uuid-1", external_id: "s1" },
      { id: "uuid-2", external_id: "s2" },
    ]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql === PRICE_UPSERT_SQL) return 1;
      if (sql === PRICE_REMOVE_SQL) return 4;
      if (sql === SCRAPE_RUN_SQL) return 1;
      return 2; // station batch
    });
    const inTx: string[] = [];
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
          inTx.push(sql);
          return mockExecuteRawUnsafe(sql, ...params);
        },
      }),
    );

    const result = await scraper.run();

    expect(inTx).toEqual([PRICE_UPSERT_SQL, PRICE_REMOVE_SQL, SCRAPE_RUN_SQL]);
    const call = (sql: string) => mockExecuteRawUnsafe.mock.calls.find(([s]) => s === sql)!;
    expect(call(PRICE_UPSERT_SQL)[2]).toBe("test_source");
    expect(call(PRICE_REMOVE_SQL).slice(1)).toEqual([
      "test_source",
      "XX",
      JSON.stringify([
        { station_id: "uuid-1", fuel_type: "B7" },
        { station_id: "uuid-2", fuel_type: "E5" },
      ]),
    ]);
    expect(call(SCRAPE_RUN_SQL).slice(1)).toEqual(["XX", "test_source"]);
    expect(result).toMatchObject({
      stationsUpserted: 2,
      stationsChanged: 2,
      pricesUpserted: 2,
      pricesChanged: 1,
      pricesRemoved: 4,
      errors: [],
    });
  });

  it("does not count a rolled-back price transaction as written", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.45)];
    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-1", external_id: "s1" }]);
    mockExecuteRawUnsafe.mockImplementation(async (sql: string) => {
      if (sql === SCRAPE_RUN_SQL) throw new Error("deadlock detected");
      return 1;
    });

    const result = await scraper.run();

    expect(result.pricesChanged).toBe(0);
    expect(result.pricesRemoved).toBe(0);
    expect(result.errors).toEqual(["Fatal: deadlock detected"]);
  });

  it("keeps one price per station and fuel, the one readers showed", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [
      makePrice("s1", "B7", 1.45), // self-service, emitted first
      makePrice("s1", "B7", 1.65), // served
      makePrice("s1", "E5", 1.7),
    ];
    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-1", external_id: "s1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(0);

    const result = await scraper.run();

    expect(result.pricesUpserted).toBe(2);
    expect(priceRows().map((r) => [r.fuel_type, r.price])).toEqual([
      ["B7", 1.45],
      ["E5", 1.7],
    ]);
  });

  it("sends prices in chunks, sorted by station and fuel", async () => {
    const stations = Array.from({ length: 6000 }, (_, i) => makeStation(`s${i}`));
    scraper.mockStations = stations;
    scraper.mockPrices = stations.flatMap((s) => [makePrice(s.externalId, "E5"), makePrice(s.externalId, "B7")]);
    // UUIDs in the reverse order of emission, so sorting is visible.
    mockQueryRawUnsafe.mockResolvedValueOnce(
      stations.map((s, i) => ({ id: `uuid-${String(99999 - i).padStart(5, "0")}`, external_id: s.externalId })),
    );
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(0);

    await scraper.run();

    const chunks = mockExecuteRawUnsafe.mock.calls.filter(([sql]) => sql === PRICE_UPSERT_SQL);
    expect(chunks.map(([, rows]) => (JSON.parse(rows as string) as unknown[]).length)).toEqual([5000, 5000, 2000]);
    const keys = priceRows().map((r) => `${r.station_id}/${r.fuel_type}`);
    expect(keys).toEqual([...keys].sort());
    expect(keys.slice(0, 2)).toEqual(["uuid-94000/B7", "uuid-94000/E5"]);
  });

  it("remembers the stations of successful batches only, for the EV sweeps", async () => {
    const stations = Array.from({ length: 600 }, (_, i) => ({ ...makeStation(`ev${i}`), stationType: "ev_charger" as const }));
    scraper.mockStations = stations;
    scraper.mockPrices = [];
    mockExecuteRawUnsafe.mockRejectedValueOnce(new Error("batch failed")).mockResolvedValue(0);
    mockQueryRawUnsafe.mockResolvedValue([]);

    await scraper.run();

    const listed = (scraper as unknown as { lastRunExternalIds: string[] }).lastRunExternalIds;
    expect(listed).toEqual(stations.slice(500).map((s) => s.externalId));
  });

  it("always disconnects even on error", async () => {
    scraper.shouldThrow = true;

    await scraper.run();

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe("isPlausibleEvPrice", () => {
  it("accepts EUR between 0.10 and 2.00 per kWh", () => {
    expect(isPlausibleEvPrice(0.1, "EUR")).toBe(true);
    expect(isPlausibleEvPrice(2, "EUR")).toBe(true);
    expect(isPlausibleEvPrice(0.05, "EUR")).toBe(false);
    expect(isPlausibleEvPrice(2.5, "EUR")).toBe(false);
    expect(isPlausibleEvPrice(0.5, "CHF")).toBe(false);
  });
});

describe("sanePowerKw", () => {
  it("rounds plausible values", () => {
    expect(sanePowerKw(22)).toBe(22);
    expect(sanePowerKw(149.6)).toBe(150);
  });

  it("returns null for missing, implausible or sub-kW values", () => {
    expect(sanePowerKw(null)).toBeNull();
    expect(sanePowerKw(undefined)).toBeNull();
    expect(sanePowerKw(Number.NaN)).toBeNull();
    expect(sanePowerKw(0)).toBeNull();
    expect(sanePowerKw(-5)).toBeNull();
    expect(sanePowerKw(0.3)).toBeNull();
    expect(sanePowerKw(1001)).toBeNull();
  });
});

describe("maxSanePowerKw", () => {
  it("keeps the highest valid value when a larger one is implausible", () => {
    expect(maxSanePowerKw([150, 1200])).toBe(150);
    expect(maxSanePowerKw([22, null, Number.NaN, 49.6])).toBe(50);
  });

  it("returns null when no value is valid", () => {
    expect(maxSanePowerKw([])).toBeNull();
    expect(maxSanePowerKw([null, undefined, 0, 5000])).toBeNull();
  });
});

describe("dedupePrices", () => {
  const at = (iso: string) => new Date(iso);

  it("keeps the first emitted price on a tie", () => {
    const kept = dedupePrices([makePrice("s1", "B7", 1.45), makePrice("s1", "B7", 1.65), makePrice("s2", "B7", 1.5)]);
    expect(kept.map((p) => [p.stationExternalId, p.price])).toEqual([
      ["s1", 1.45],
      ["s2", 1.5],
    ]);
  });

  it("keeps the newest upstream date, and counts an undated price as newest", () => {
    const old = { ...makePrice("s1", "EV", 0.5), reportedAt: at("2026-10-01T00:00:00Z") };
    const newer = { ...makePrice("s1", "EV", 0.6), reportedAt: at("2026-10-02T00:00:00Z") };
    const undated = makePrice("s1", "EV", 0.7);
    expect(dedupePrices([old, newer]).map((p) => p.price)).toEqual([0.6]);
    expect(dedupePrices([newer, old]).map((p) => p.price)).toEqual([0.6]);
    expect(dedupePrices([old, undated]).map((p) => p.price)).toEqual([0.7]);
    expect(dedupePrices([undated, newer]).map((p) => p.price)).toEqual([0.7]);
  });

  it("treats different fuels of one station as different prices", () => {
    expect(dedupePrices([makePrice("s1", "B7"), makePrice("s1", "E5")])).toHaveLength(2);
  });
});

describe("write-on-change SQL", () => {
  // The INSERT must read the pre-filtered rows. Reading the raw input and
  // relying on ON CONFLICT ... WHERE would still lock, dirty and WAL-log
  // every unchanged row.
  it("inserts only rows that differ from the database", () => {
    for (const sql of [stationUpsertSql(false), stationUpsertSql(true), PRICE_UPSERT_SQL]) {
      expect(sql).toMatch(/changed AS \([\s\S]*IS DISTINCT FROM[\s\S]*\)\s*INSERT INTO/);
      expect(sql).toMatch(/FROM changed\s+ORDER BY/);
    }
  });

  it("compares every column a station upsert writes", () => {
    const sql = stationUpsertSql(true);
    for (const col of ["name", "brand", "address", "city", "province", "station_type", "geom", "max_power_kw"]) {
      expect(sql).toContain(`s.${col}`);
      expect(sql).toMatch(new RegExp(`${col}\\s+= EXCLUDED\\.${col}`));
    }
    expect(stationUpsertSql(false)).not.toContain("max_power_kw");
  });

  it("compares every column a price upsert writes", () => {
    for (const col of ["price", "currency", "ev_fees", "reported_at"]) {
      expect(PRICE_UPSERT_SQL).toContain(`fp.${col}`);
      expect(PRICE_UPSERT_SQL).toMatch(new RegExp(`${col}\\s+= EXCLUDED\\.${col}`));
    }
  });
});
