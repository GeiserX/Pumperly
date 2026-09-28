import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../generated/prisma/client", () => ({ PrismaClient: vi.fn() }));

function station(overrides: Record<string, unknown> = {}) {
  return {
    key: "ao_000",
    name: "Baldursnes Akureyri",
    company: "Atlantsolía",
    bensin95: 249.4,
    bensin95_discount: 244.4,
    diesel: 291.7,
    diesel_discount: 286.7,
    geo: { lat: 65.69913, lon: -18.135231 },
    ...overrides,
  };
}

function mockFeed(payload: unknown, ok = true, status = 200) {
  vi.mocked(fetch).mockImplementation(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as Response);
}

async function fetchWith(payload: unknown) {
  const { IcelandScraper } = await import("./iceland");
  return new IcelandScraper().fetch();
}

describe("IcelandScraper", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("has correct country and source", async () => {
    const { IcelandScraper } = await import("./iceland");
    const s = new IcelandScraper();
    expect(s.country).toBe("IS");
    expect(s.source).toBe("gasvaktin");
  });

  it("reads the gasvaktin JSON in one request with our User-Agent", async () => {
    mockFeed({ stations: [station()] });
    await fetchWith(null);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe(
      "https://raw.githubusercontent.com/gasvaktin/gasvaktin/master/vaktin/gas.json",
    );
    expect((init as RequestInit).headers).toMatchObject({ "User-Agent": "Pumperly/1.0" });
  });

  it("maps pump prices (not member discounts) to E5 and B7 in ISK", async () => {
    mockFeed({ stations: [station()] });
    const { stations, prices } = await fetchWith(null);

    expect(stations).toHaveLength(1);
    expect(stations[0]).toMatchObject({
      externalId: "is-gv-ao_000",
      name: "Atlantsolía Baldursnes Akureyri",
      brand: "Atlantsolía",
      latitude: 65.69913,
      longitude: -18.135231,
      stationType: "fuel",
    });
    expect(prices).toHaveLength(2);
    expect(prices).toContainEqual({
      stationExternalId: "is-gv-ao_000",
      fuelType: "E5",
      price: 249.4,
      currency: "ISK",
    });
    expect(prices).toContainEqual({
      stationExternalId: "is-gv-ao_000",
      fuelType: "B7",
      price: 291.7,
      currency: "ISK",
    });
    expect(prices.map((p) => p.price)).not.toContain(244.4);
  });

  it("does not repeat the brand when the name already starts with it", async () => {
    mockFeed({ stations: [station({ name: "Atlantsolía Kaplakriki", company: "Atlantsolía" })] });
    const { stations } = await fetchWith(null);
    expect(stations[0].name).toBe("Atlantsolía Kaplakriki");
  });

  it("skips stations with no price, a missing geo, or coordinates outside Iceland", async () => {
    mockFeed({
      stations: [
        station({ key: "a", bensin95: null, diesel: null }),
        station({ key: "b", geo: null }),
        station({ key: "c", geo: { lat: 59.33, lon: 18.06 } }),
        station({ key: "d", bensin95: 0, diesel: 300.1 }),
      ],
    });
    const { stations, prices } = await fetchWith(null);
    expect(stations.map((s) => s.externalId)).toEqual(["is-gv-d"]);
    expect(prices).toEqual([
      { stationExternalId: "is-gv-d", fuelType: "B7", price: 300.1, currency: "ISK" },
    ]);
  });

  it("skips non-object members and repeated keys instead of failing the run", async () => {
    mockFeed({ stations: [station({ key: "x" }), null, 7, "s", station({ key: "x" }), station({ key: "y" })] });
    const { stations } = await fetchWith(null);
    expect(stations.map((s) => s.externalId)).toEqual(["is-gv-x", "is-gv-y"]);
  });

  it("throws on a non-OK response", async () => {
    mockFeed("nope", false, 503);
    await expect(fetchWith(null)).rejects.toThrow("HTTP 503");
  });

  it("throws when the payload has no stations array", async () => {
    mockFeed({ stations: { ao_000: station() } });
    await expect(fetchWith(null)).rejects.toThrow("no stations array");
  });
});
