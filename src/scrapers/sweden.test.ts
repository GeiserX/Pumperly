import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: vi.fn(),
}));

vi.mock("../generated/prisma/client", () => ({
  PrismaClient: vi.fn(),
}));

/** One fully-populated feed row; override fields per test. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 114,
    lat: 59.334,
    lng: 18.063,
    company: "Preem",
    address: "Sveavägen 10",
    commune: "Stockholm",
    county: "Stockholms län",
    link: "/station/stockholms-lan/stockholm/sveavagen-10",
    price95: 17.17,
    price98: null,
    priceDiesel: 22.28,
    priceLpg: null,
    priceEtanol: null,
    priceFordonsgas: null,
    priceBiodiesel: null,
    countyLink: "stockholms-lan",
    communeLink: "stockholm",
    companyLink: "preem",
    ...overrides,
  };
}

function mockFeed(payload: unknown, ok = true, status = 200) {
  vi.mocked(fetch).mockImplementation(async () => {
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  });
}

describe("SwedenScraper", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("has correct country and source", async () => {
    const { SwedenScraper } = await import("./sweden");
    const scraper = new SwedenScraper();
    expect(scraper.country).toBe("SE");
    expect(scraper.source).toBe("bensinpriser");
  });

  it("reads the bensinpriser.nu bulk map feed in a single request", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([row()]);

    await new SwedenScraper().fetch();

    expect(fetch).toHaveBeenCalledTimes(1);
    const url = vi.mocked(fetch).mock.calls[0][0];
    expect(String(url)).toBe("https://bensinpriser.nu/karta/data");
  });

  it("parses the feed into stations and prices", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([
      row(),
      row({
        id: 564,
        company: "OKQ8",
        address: "Avenyn 20",
        commune: "Göteborg",
        county: "Västra Götalands län",
        lat: 57.7,
        lng: 11.975,
        price95: 17.49,
        priceDiesel: null,
      }),
    ]);

    const { stations, prices } = await new SwedenScraper().fetch();

    expect(stations).toHaveLength(2);

    const preem = stations.find((s) => s.externalId === "se-bp-114");
    expect(preem).toBeDefined();
    expect(preem!.name).toBe("Preem Stockholm");
    expect(preem!.brand).toBe("Preem");
    expect(preem!.address).toBe("Sveavägen 10");
    expect(preem!.city).toBe("Stockholm");
    expect(preem!.province).toBe("Stockholms län");
    expect(preem!.latitude).toBeCloseTo(59.334, 3);
    expect(preem!.longitude).toBeCloseTo(18.063, 3);
    expect(preem!.stationType).toBe("fuel");

    const okq8 = stations.find((s) => s.externalId === "se-bp-564");
    expect(okq8).toBeDefined();
    expect(okq8!.brand).toBe("OKQ8");

    // Preem: E5 + B7 = 2; OKQ8: E5 = 1 => 3 total
    expect(prices).toHaveLength(3);

    const diesel = prices.find(
      (p) => p.stationExternalId === "se-bp-114" && p.fuelType === "B7",
    );
    expect(diesel).toBeDefined();
    expect(diesel!.price).toBeCloseTo(22.28, 2);
    expect(diesel!.currency).toBe("SEK");
  });

  it("maps every priced feed field to its harmonised fuel type", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([
      row({
        price95: 17.17,
        price98: 19.35,
        priceDiesel: 22.28,
        priceEtanol: 14.89,
        priceFordonsgas: 25.9,
        priceBiodiesel: 31.19,
      }),
    ]);

    const { prices } = await new SwedenScraper().fetch();

    const byFuel = Object.fromEntries(prices.map((p) => [p.fuelType, p.price]));
    expect(byFuel).toEqual({
      E5: 17.17,
      E5_98: 19.35,
      B7: 22.28,
      HVO: 31.19,
      CNG: 25.9,
    });
  });

  it("drops E85 (priceEtanol) and its priceLpg duplicate: neither is an E10 or LPG price", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([
      row({
        priceEtanol: 14.89,
        priceLpg: 14.89,
      }),
    ]);

    const { prices } = await new SwedenScraper().fetch();

    expect(prices.some((p) => p.fuelType === "E10" || p.fuelType === "LPG")).toBe(false);
    expect(prices.length).toBeGreaterThan(0);
  });

  it("treats the 'Övriga' placeholder as an unbranded station", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([row({ company: "Övriga" })]);

    const { stations } = await new SwedenScraper().fetch();

    expect(stations).toHaveLength(1);
    expect(stations[0].brand).toBeNull();
    expect(stations[0].name).toBe("Stockholm");
  });

  it("filters stations outside the Sweden bounding box", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([row({ lat: 50.0, lng: 12.0 })]);

    const { stations } = await new SwedenScraper().fetch();
    expect(stations).toHaveLength(0);
  });

  it("drops stations with no reported price and skips non-positive prices", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([
      row({ id: 1, price95: null, priceDiesel: null }),
      row({ id: 2, price95: 0, priceDiesel: -5 }),
    ]);

    const { stations, prices } = await new SwedenScraper().fetch();
    expect(stations).toHaveLength(0);
    expect(prices).toHaveLength(0);
  });

  it("skips rows with missing or unparseable coordinates", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([row({ lat: null }), row({ id: 2, lng: null })]);

    const { stations } = await new SwedenScraper().fetch();
    expect(stations).toHaveLength(0);
  });

  it("skips non-object members instead of failing the whole run", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([row({ id: 1 }), null, 42, "x", [row({ id: 9 })], row({ id: 2 })]);
    const { stations } = await new SwedenScraper().fetch();
    expect(stations.map((s) => s.externalId)).toEqual(["se-bp-1", "se-bp-2"]);
  });

  it("deduplicates repeated feed ids", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed([row(), row()]);

    const { stations, prices } = await new SwedenScraper().fetch();
    expect(stations).toHaveLength(1);
    expect(prices).toHaveLength(2);
  });

  it("throws when the feed returns a non-OK response", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed({ error: "nope" }, false, 503);

    await expect(new SwedenScraper().fetch()).rejects.toThrow("HTTP 503");
  });

  it("throws when the feed is not an array", async () => {
    const { SwedenScraper } = await import("./sweden");
    mockFeed({ stations: [] });

    await expect(new SwedenScraper().fetch()).rejects.toThrow(
      "did not return an array",
    );
  });
});

// The handover from the retired DrivstoffAppen source: the only destructive
// thing this scraper does.
describe("SwedenScraper handover cleanup", () => {
  async function runWith(result: { stationsUpserted: number; errors: string[] }) {
    const { BaseScraper } = await import("./base");
    const { PrismaClient } = await import("../generated/prisma/client");
    const { SwedenScraper } = await import("./sweden");

    vi.spyOn(BaseScraper.prototype, "run").mockResolvedValue({
      country: "SE",
      source: "bensinpriser",
      pricesUpserted: 0,
      durationMs: 1,
      ...result,
    });
    const $executeRawUnsafe = vi.fn().mockResolvedValue(3);
    vi.mocked(PrismaClient).mockImplementation(function () {
      return { $executeRawUnsafe, $disconnect: vi.fn() };
    } as never);

    await new SwedenScraper().run();
    return $executeRawUnsafe;
  }

  afterEach(() => vi.restoreAllMocks());

  it("retires only Swedish drivstoffappen and bensinpriser_nu prices, then the stations left without a price", async () => {
    const exec = await runWith({ stationsUpserted: 491, errors: [] });

    expect(exec).toHaveBeenCalledTimes(2);
    const [pricesSql, source] = exec.mock.calls[0];
    expect(pricesSql).toMatch(/DELETE FROM fuel_prices/);
    expect(pricesSql).toMatch(/country = 'SE'/);
    expect(pricesSql).toMatch(/source = ANY\(\$1::text\[\]\)/);
    expect(source).toEqual(["drivstoffappen", "bensinpriser_nu"]);
    const [stationsSql] = exec.mock.calls[1];
    expect(stationsSql).toMatch(/DELETE FROM stations/);
    expect(stationsSql).toMatch(/country = 'SE' AND station_type = 'fuel'/);
    expect(stationsSql).toMatch(/NOT EXISTS/);
  });

  it("deletes nothing after a failed or degraded run", async () => {
    expect(await runWith({ stationsUpserted: 491, errors: ["boom"] })).not.toHaveBeenCalled();
    expect(await runWith({ stationsUpserted: 40, errors: [] })).not.toHaveBeenCalled();
  });
});
