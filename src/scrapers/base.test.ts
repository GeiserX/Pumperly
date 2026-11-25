import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Prisma adapter + client at module level
const mockExecuteRawUnsafe = vi.fn();
const mockQueryRawUnsafe = vi.fn();
const mockTxQueryRawUnsafe = vi.fn();
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
  PRICE_LOCK_SQL,
  PRICE_SOURCE_MARK_SQL,
  PRICE_SYNC_SQL,
  PRICE_WORK_MEM_SQL,
  bandFor,
  dedupePrices,
  isPlausibleEvPrice,
  stationUpsertSql,
  maxSanePowerKw,
  sanePowerKw,
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
    mockTxQueryRawUnsafe.mockReset();
    mockTransaction.mockReset();
    mockDisconnect.mockReset();

    // Default: station lookup returns matching IDs
    mockQueryRawUnsafe.mockResolvedValue([]);
    // Default: the price sync reports nothing written
    mockTxQueryRawUnsafe.mockResolvedValue([{ deleted: BigInt(0), updated: BigInt(0), inserted: BigInt(0) }]);
    // Default: transaction executes the callback
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: mockExecuteRawUnsafe,
        $queryRawUnsafe: mockTxQueryRawUnsafe,
      }),
    );
  });

  /** The jsonb payload the price sync was handed. */
  function syncPayload(): Array<Record<string, unknown>> {
    const call = mockTxQueryRawUnsafe.mock.calls.find(([sql]) => sql === PRICE_SYNC_SQL);
    expect(call).toBeDefined();
    return JSON.parse(call![1] as string);
  }

  /** The parameters of the price_sources marker upsert. */
  function markParams(): unknown[] {
    const call = mockExecuteRawUnsafe.mock.calls.find(([sql]) => sql === PRICE_SOURCE_MARK_SQL);
    expect(call).toBeDefined();
    return call!.slice(1);
  }

  afterEach(() => {
    process.env = ORIG_ENV;
    vi.restoreAllMocks();
  });

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
    // 11 params per station; the 11th is max_power_kw (null when unset).
    expect(stationCall![0]).toContain("max_power_kw = EXCLUDED.max_power_kw");
    const params = stationCall!.slice(1);
    expect(params).toHaveLength(22);
    expect(params[10]).toBeNull();
    expect(params[21]).toBe(150);
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
    // The ids the EV sweeps use to tell a live charger from a gone one.
    expect((scraper as unknown as { lastRunExternalIds: string[] }).lastRunExternalIds).toEqual(["s1", "s2"]);

    // Verify station upsert SQL was called
    const stationCall = mockExecuteRawUnsafe.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("INSERT INTO stations"),
    );
    expect(stationCall).toBeDefined();
    // Fuel-only batch: no max_power_kw, so it runs on an un-migrated database.
    expect(stationCall![0]).not.toContain("max_power_kw");
    expect(stationCall!.slice(1)).toHaveLength(20);

    // The price transaction: more work_mem, the per-source lock, one sync
    // statement with every row, then the marker. In that order.
    const txSql = [
      ...mockExecuteRawUnsafe.mock.calls.map((c, i) => ({ sql: c[0], order: mockExecuteRawUnsafe.mock.invocationCallOrder[i] })),
      ...mockTxQueryRawUnsafe.mock.calls.map((c, i) => ({ sql: c[0], order: mockTxQueryRawUnsafe.mock.invocationCallOrder[i] })),
    ]
      .filter(({ sql }) => !String(sql).includes("INSERT INTO stations"))
      .sort((a, b) => a.order - b.order)
      .map(({ sql }) => sql);
    expect(txSql).toEqual([PRICE_WORK_MEM_SQL, PRICE_LOCK_SQL, PRICE_SYNC_SQL, PRICE_SOURCE_MARK_SQL]);
    const lock = mockExecuteRawUnsafe.mock.calls.find(([sql]) => sql === PRICE_LOCK_SQL);
    expect(lock!.slice(1)).toEqual(["XX", "test_source"]);
    const sync = mockTxQueryRawUnsafe.mock.calls.find(([sql]) => sql === PRICE_SYNC_SQL);
    // One string bind for every row, then source, country and the mixed flag.
    expect(sync!.slice(2)).toEqual(["test_source", "XX", false]);
    expect(syncPayload()).toEqual([
      { station_id: "uuid-1", fuel_type: "B7", price: 1.45, currency: "EUR", ev_fees: null, reported_at: null },
      { station_id: "uuid-2", fuel_type: "E5", price: 1.6, currency: "EUR", ev_fees: null, reported_at: null },
    ]);
    // Undated rows: the marker gets now().
    expect(markParams()).toEqual(["XX", "test_source", false]);
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

    // The fees travel as an object inside the one JSON payload, so Postgres
    // stores a jsonb object, not a JSON string.
    expect(syncPayload()[0].ev_fees).toEqual({ perMinute: 0.24, afterMin: 30 });
  });

  it("sends a null ev_fees for fuel prices", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.5, "EUR")];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-1", external_id: "s1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    await scraper.run();
    expect(syncPayload()[0].ev_fees).toBeNull();
  });

  it("sends the upstream reported_at and leaves the marker NULL when every price carries one", async () => {
    scraper.mockStations = [{ ...makeStation("ev1"), stationType: "ev_charger" }];
    scraper.mockPrices = [{ ...makePrice("ev1", "EV", 0.79, "EUR"), reportedAt: new Date("2026-10-20T04:00:00Z") }];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-ev", external_id: "ev1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    await scraper.run();
    expect(syncPayload()[0].reported_at).toBe("2026-10-20T04:00:00.000Z");
    const sync = mockTxQueryRawUnsafe.mock.calls.find(([sql]) => sql === PRICE_SYNC_SQL);
    expect(sync![4]).toBe(false); // not mixed
    expect(markParams()).toEqual(["XX", "test_source", true]); // dated: marker NULL
  });

  it("flags a run that mixes dated and undated prices", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [
      { ...makePrice("s1", "B7", 1.5, "EUR"), reportedAt: new Date("2026-10-20T04:00:00Z") },
      makePrice("s1", "E5", 1.6, "EUR"),
    ];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-1", external_id: "s1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);

    await scraper.run();
    const sync = mockTxQueryRawUnsafe.mock.calls.find(([sql]) => sql === PRICE_SYNC_SQL);
    // Mixed: the undated rows are dated now(), and so rewritten, every run.
    expect(sync![4]).toBe(true);
    expect(markParams()).toEqual(["XX", "test_source", true]);
  });

  it("keeps the lowest of two prices for one station and fuel", async () => {
    scraper.mockStations = [makeStation("s1")];
    scraper.mockPrices = [makePrice("s1", "B7", 1.62), makePrice("s1", "B7", 1.49), makePrice("s1", "E5", 1.7)];

    mockQueryRawUnsafe.mockResolvedValueOnce([{ id: "uuid-1", external_id: "s1" }]);
    mockQueryRawUnsafe.mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRawUnsafe.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scraper.run();
    expect(result.pricesUpserted).toBe(2);
    expect(syncPayload().map((r) => [r.fuel_type, r.price])).toEqual([["B7", 1.49], ["E5", 1.7]]);
    expect(log.mock.calls.flat().join("\n")).toContain("Collapsed 1 duplicate price rows (kept the lowest)");
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
    // The EV sweeps must not trust a partial list.
    expect((scraper as unknown as { lastRunExternalIds: string[] }).lastRunExternalIds).toEqual([]);
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
  const p = (price: number, extra: Partial<{ evFees: { perMinute: number }; reportedAt: Date; fuelType: string }> = {}) => ({
    stationId: "uuid-1",
    fuelType: extra.fuelType ?? "B7",
    price,
    currency: "EUR",
    ...(extra.evFees ? { evFees: extra.evFees } : {}),
    ...(extra.reportedAt ? { reportedAt: extra.reportedAt } : {}),
  });

  it("keeps the lowest price per station and fuel, with its own fees and time", () => {
    const cheap = p(1.49, { evFees: { perMinute: 0.1 }, reportedAt: new Date("2026-11-01T00:00:00Z") });
    const kept = dedupePrices([p(1.62), cheap, p(1.7, { fuelType: "E5" })]);
    expect(kept).toEqual([cheap, p(1.7, { fuelType: "E5" })]);
  });

  it("picks the same row whatever order the upstream lists them in", () => {
    const rows = [
      p(1.5, { reportedAt: new Date("2026-11-01T00:00:00Z") }),
      p(1.5, { reportedAt: new Date("2026-11-02T00:00:00Z") }),
      p(1.5, { evFees: { perMinute: 0.2 } }),
      p(1.5),
      p(1.6),
    ];
    const forward = dedupePrices(rows);
    const backward = dedupePrices([...rows].reverse());
    expect(forward).toHaveLength(1);
    expect(backward).toEqual(forward);
  });
});

describe("stationUpsertSql", () => {
  it("filters unchanged rows before the INSERT and guards the update", () => {
    const sql = stationUpsertSql(2, false);
    expect(sql).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM stations s/);
    // NULL-safe compare, coordinates included, so a row without geom is not rewritten each run.
    expect(sql).toContain("ST_X(s.geom), ST_Y(s.geom))\n            IS NOT DISTINCT FROM");
    expect(sql).toMatch(/ON CONFLICT \(external_id, country\)\s+DO UPDATE SET/);
    expect(sql).toMatch(/updated_at\s+= NOW\(\)\s+WHERE \(stations\.name/);
    expect(sql).toContain("IS DISTINCT FROM (EXCLUDED.name");
    // Typed parameters, numbered per row.
    expect(sql).toContain("($1::text, $2::varchar, $3::text");
    expect(sql).toContain("$19::float8, $20::float8)");
    expect(sql).not.toContain("$21");
    expect(sql).not.toContain("max_power_kw");
  });

  it("compares and writes max_power_kw only for charger batches", () => {
    const sql = stationUpsertSql(2, true);
    expect(sql).toContain("$11::smallint");
    expect(sql).toContain("$22::smallint");
    expect(sql).toContain("s.max_power_kw");
    expect(sql).toContain("max_power_kw = EXCLUDED.max_power_kw,");
  });
});

describe("price sync SQL", () => {
  it("writes only rows whose value changed", () => {
    expect(PRICE_SYNC_SQL).toMatch(/IS DISTINCT FROM \(i\.price, i\.currency, i\.ev_fees\)/);
    expect(PRICE_SYNC_SQL).toContain("OR (i.reported_at IS NOT NULL AND i.reported_at IS DISTINCT FROM c.reported_at)");
    // Legacy duplicates beyond the first row of a key are deleted.
    expect(PRICE_SYNC_SQL).toContain("c.rn > 1 OR NOT EXISTS");
    // Same scope as the old full replace: this source, this country's stations.
    expect(PRICE_SYNC_SQL).toContain("WHERE fp.source = $2 AND s.country = $3");
    expect(PRICE_SYNC_SQL).toContain("jsonb_to_recordset($1::jsonb)");
  });

  it("marks the source NULL when its rows carry an upstream time, now() otherwise", () => {
    expect(PRICE_SOURCE_MARK_SQL).toContain("CASE WHEN $3::boolean THEN NULL ELSE statement_timestamp() END");
    expect(PRICE_SOURCE_MARK_SQL).toContain("ON CONFLICT (country, source) DO UPDATE SET confirmed_at = EXCLUDED.confirmed_at");
  });
});
