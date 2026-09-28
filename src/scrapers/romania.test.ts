import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../generated/prisma/client", () => ({ PrismaClient: vi.fn() }));

describe("RomaniaScraper", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("setTimeout", (fn: () => void) => { fn(); return 0 as unknown as NodeJS.Timeout; });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("has correct country and source", async () => {
    const { RomaniaScraper } = await import("./romania");
    const scraper = new RomaniaScraper();
    expect(scraper.country).toBe("RO");
    expect(scraper.source).toBe("peco_online");
  });

  it("parses Parse API response with fuel prices", async () => {
    const { RomaniaScraper } = await import("./romania");
    const scraper = new RomaniaScraper();

    const mockResponse = {
      results: [
        {
          objectId: "abc123",
          Id: "RO-001",
          Retea: "Petrom",
          Statie: "Petrom Bucuresti",
          Adresa: "Bd. Unirii 10",
          Oras: "Bucuresti",
          Judet: "Bucuresti",
          lat: 44.4268,
          lng: 26.1025,
          Benzina_Regular: 6.89,
          Benzina_Premium: 7.49,
          Motorina_Regular: 7.19,
          Motorina_Premium: 7.79,
          GPL: 3.49,
          AdBlue: 4.99,
        },
      ],
      count: 1,
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const { stations, prices } = await scraper.fetch();

    expect(stations).toHaveLength(1);
    expect(stations[0].externalId).toBe("RO-001");
    expect(stations[0].name).toBe("Petrom Bucuresti");
    expect(stations[0].brand).toBe("Petrom");
    expect(stations[0].city).toBe("Bucuresti");
    expect(stations[0].province).toBe("Bucuresti");
    expect(stations[0].latitude).toBeCloseTo(44.4268, 3);

    expect(prices).toHaveLength(6);
    expect(prices.find((p) => p.fuelType === "E5")!.price).toBeCloseTo(6.89, 2);
    expect(prices.find((p) => p.fuelType === "B7")!.price).toBeCloseTo(7.19, 2);
    expect(prices.find((p) => p.fuelType === "LPG")!.price).toBeCloseTo(3.49, 2);
    expect(prices[0].currency).toBe("RON");
  });

  it("throws on non-OK HTTP response", async () => {
    const { RomaniaScraper } = await import("./romania");
    const scraper = new RomaniaScraper();

    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    await expect(scraper.fetch()).rejects.toThrow("Peco Online HTTP 500");
  });

  it("filters out 999999 sentinel values", async () => {
    const { RomaniaScraper } = await import("./romania");
    const scraper = new RomaniaScraper();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            objectId: "xyz",
            Id: "RO-002",
            Retea: "OMV",
            Statie: "OMV Cluj",
            Adresa: "Str. X",
            Oras: "Cluj",
            Judet: "Cluj",
            lat: 46.77,
            lng: 23.59,
            Benzina_Regular: 6.5,
            Benzina_Premium: 999999,
            Motorina_Regular: 999999,
            Motorina_Premium: 0,
            GPL: 3.2,
            AdBlue: 999999,
          },
        ],
        count: 1,
      }),
    } as Response);

    const { prices } = await scraper.fetch();
    // Only Benzina_Regular (6.5) and GPL (3.2) are valid
    expect(prices).toHaveLength(2);
    expect(prices.find((p) => p.fuelType === "E5")).toBeDefined();
    expect(prices.find((p) => p.fuelType === "LPG")).toBeDefined();
  });

  it("uses objectId as fallback when Id is missing", async () => {
    const { RomaniaScraper } = await import("./romania");
    const scraper = new RomaniaScraper();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            objectId: "fallback-id",
            Id: "",
            Retea: "Mol",
            Statie: "Mol Timisoara",
            Adresa: "",
            Oras: "Timisoara",
            Judet: "Timis",
            lat: 45.75,
            lng: 21.23,
            Benzina_Regular: 6.5,
            Benzina_Premium: 0,
            Motorina_Regular: 0,
            Motorina_Premium: 0,
            GPL: 0,
            AdBlue: 0,
          },
        ],
        count: 1,
      }),
    } as Response);

    const { stations } = await scraper.fetch();
    expect(stations).toHaveLength(1);
    expect(stations[0].externalId).toBe("fallback-id");
  });

  it("keeps two different stations apart when upstream reuses one Id across pages", async () => {
    const { RomaniaScraper } = await import("./romania");
    const scraper = new RomaniaScraper();

    const row = (over: Record<string, unknown>) => ({
      objectId: "o",
      Id: "id",
      Retea: "Socar",
      Statie: "S",
      Adresa: "",
      Oras: "",
      Judet: "",
      lat: 45,
      lng: 25,
      Benzina_Regular: 7.1,
      Benzina_Premium: 0,
      Motorina_Regular: 0,
      Motorina_Premium: 0,
      GPL: 0,
      AdBlue: 0,
      ...over,
    });

    // The collision we hit in production straddles a page boundary, so the id
    // has to be decided over the whole result set, not page by page.
    const filler = Array.from({ length: 999 }, (_, i) =>
      row({ objectId: `f${i}`, Id: `f${i}`, lat: 45 + i / 10000 }),
    );
    const first = row({ objectId: "a", Id: "4530", Statie: "Buzau", lat: 45.171117, lng: 26.811179 });
    const second = row({ objectId: "b", Id: "4530", Statie: "Slobozia", lat: 44.558319, lng: 27.368864 });

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [...filler, first], count: 1001 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [second], count: 1001 }),
      } as Response);

    const { stations, prices } = await scraper.fetch();

    const ids = stations.map((st) => st.externalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("4530@45.171117,26.811179");
    expect(ids).toContain("4530@44.558319,27.368864");
    expect(ids).not.toContain("4530");
    // Prices follow the disambiguated id so they land on the right station.
    expect(
      prices.filter((pr) => pr.stationExternalId === "4530@44.558319,27.368864"),
    ).toHaveLength(1);
  });

  it("collapses a station listed twice under the same Id", async () => {
    const { RomaniaScraper } = await import("./romania");
    const scraper = new RomaniaScraper();

    const duplicate = {
      objectId: "dup-a",
      Id: "RO.1618.8",
      Retea: "Petrom",
      Statie: "Statia Com. Selimbar",
      Adresa: "DN 1",
      Oras: "Selimbar",
      Judet: "Sibiu",
      lat: 45.6999,
      lng: 24.2497,
      Benzina_Regular: 9.12,
      Benzina_Premium: 9.6,
      Motorina_Regular: 0,
      Motorina_Premium: 0,
      GPL: 0,
      AdBlue: 0,
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [duplicate, { ...duplicate, objectId: "dup-b" }],
        count: 2,
      }),
    } as Response);

    const { stations, prices } = await scraper.fetch();

    // Two identical rows are one station, and must not produce a duplicate
    // external id — the station upsert batch fails outright if they do.
    expect(stations).toHaveLength(1);
    expect(stations[0].externalId).toBe("RO.1618.8");
    expect(prices).toHaveLength(2);
  });
});
