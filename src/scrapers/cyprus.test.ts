import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../generated/prisma/client", () => ({ PrismaClient: vi.fn() }));

// Rows cut verbatim from the live observatory page (Unleaded 95), 2026-09-28.
const ROWS = {
  decimalA: "<tr> <td class=\"\">ESSO</td> <td class=\"\"> I.G. MAKRIS ENTERPRISES LTD</td> <td class=\"\"> <a class=\"multiLine normalFontWeight\" data-ajax=\"false\" href=\"/MCIT/MCIT/PetroleumPrices/DisplayMap?coordinates=35.1845138888889%2C33.3895\" target=\"_blank\">Καντάρας 58 Τ.Κ 1037 τηλ: 22433430</a> </td> <td class=\"\">Καϊμακλί</td> <td class=\"\">1.717</td> </tr>",
  decimalB: "<tr> <td class=\"\">PETROLINA</td> <td class=\"\"> MICHALIS KNEKNAS TRADING LTD</td> <td class=\"\"> <a class=\"multiLine normalFontWeight\" data-ajax=\"false\" href=\"/MCIT/MCIT/PetroleumPrices/DisplayMap?coordinates=35.148666%2C33.212235\" target=\"_blank\">Γρηγόρη Αυξεντίου 76, Κοκκινοτριμιθιά Τ.Κ 2660 τηλ: 22834160</a> </td> <td class=\"\">Κοκκινοτριμιθιά</td> <td class=\"\">1.695</td> </tr>",
  dms: "<tr> <td class=\"\">ΑΝΕΞΑΡΤΗΤΟ ΠΡΑΤΗΡΙΟ</td> <td class=\"\">ARTEMIS A. GEORGIOU PETROL STATION LTD</td> <td class=\"\"> <a class=\"multiLine normalFontWeight\" data-ajax=\"false\" href=\"/MCIT/MCIT/PetroleumPrices/DisplayMap?coordinates=34%C2%B039%2713.5%22N%2032%C2%B058%2726.3%22E\" target=\"_blank\">Λεωφ. Κωνσταντίνου &amp; Ευριπίδου 1 Τ.Κ 4651 τηλ: 25873040</a> </td> <td class=\"\">Τραχώνι</td> <td class=\"\">1.747</td> </tr>",
  offline: "<tr> <td class=\"isOffLine\">FILL N GO</td> <td class=\"isOffLine\">FILL N GO STATIONS LTD</td> <td class=\"isOffLine\"> <a class=\"multiLine normalFontWeight\" data-ajax=\"false\" href=\"/MCIT/MCIT/PetroleumPrices/DisplayMap?coordinates=34.92639%2C%2033.44032\" target=\"_blank\">Λεωφ. Λάρνακος 1 Τ.Κ 7648 τηλ: 22532828</a> </td> <td class=\"isOffLine\">Πυργά</td> <td class=\"isOffLine\">1.669</td> </tr>",
  noCoords: "<tr> <td class=\"col-md-2 hidden-xs hidden-sm\" style=\"text-align: left;\"> <span> <img src=/eForms/MCIT/MCIT/PetroleumPrices/Content/Images/MoECILogo.png height=\"90\" /> </span> </td> <td class=\"col-md-8\" style=\"text-align: center;\"> <span> ΥΠΗΡΕΣΙΑ ΠΡΟΣΤΑΣΙΑΣ ΚΑΤΑΝΑΛΩΤΗ<br /> ΠΑΡΑΤΗΡΗΤΗΡΙΟ ΛΙΑΝΙΚΩΝ ΤΙΜΩΝ ΚΑΥΣΙΜΩΝ <br /> </span> </td> <td class=\"col-md-2 hidden-xs hidden-sm\" style=\"text-align: right;\"> <span> <img src=/eForms/MCIT/MCIT/PetroleumPrices/Content/Images/CPSLogo.jpg height=\"45\" /> </span> </td> </tr>",
};

const table = (...rows: string[]) => `<table><tbody>${rows.join("")}</tbody></table>`;
const FORM = `<form><input name="__RequestVerificationToken" type="hidden" value="tok123" /></form>`;

function mockSite(pages: Record<number, string>, opts: { formOk?: boolean; postStatus?: number } = {}) {
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (method === "GET") {
      return new Response(opts.formOk === false ? "<form></form>" : FORM, {
        status: 200,
        headers: { "set-cookie": "ASP.NET_SessionId=abc; path=/; HttpOnly" },
      });
    }
    const body = new URLSearchParams(String((init as RequestInit).body));
    const type = Number(body.get("Entity.PetroleumType"));
    return new Response(pages[type] ?? table(), { status: opts.postStatus ?? 200 });
  });
}

describe("parseCyprusCoordinates", () => {
  it("reads decimal pairs with a comma, a comma and space, or a bare space", async () => {
    const { parseCyprusCoordinates } = await import("./cyprus");
    expect(parseCyprusCoordinates("35.1845138888889%2C33.3895")).toEqual([35.1845138888889, 33.3895]);
    expect(parseCyprusCoordinates("34.92639%2C%2033.44032")).toEqual([34.92639, 33.44032]);
    expect(parseCyprusCoordinates("34.92639%2033.44032")).toEqual([34.92639, 33.44032]);
  });

  it("converts degrees-minutes-seconds and assigns lat/lon by hemisphere letter", async () => {
    const { parseCyprusCoordinates } = await import("./cyprus");
    const [lat, lon] = parseCyprusCoordinates("34%C2%B039%2713.5%22N%2032%C2%B058%2726.3%22E")!;
    expect(lat).toBeCloseTo(34 + 39 / 60 + 13.5 / 3600, 6);
    expect(lon).toBeCloseTo(32 + 58 / 60 + 26.3 / 3600, 6);
    const [lat2, lon2] = parseCyprusCoordinates("32%C2%B058%2726.3%22E%2034%C2%B039%2713.5%22N")!;
    expect(lat2).toBeCloseTo(lat, 6);
    expect(lon2).toBeCloseTo(lon, 6);
  });

  it("rejects garbage", async () => {
    const { parseCyprusCoordinates } = await import("./cyprus");
    expect(parseCyprusCoordinates("somewhere")).toBeNull();
    expect(parseCyprusCoordinates("%E0%A4%A")).toBeNull();
  });
});

describe("CyprusScraper", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("has correct country and source", async () => {
    const { CyprusScraper } = await import("./cyprus");
    const s = new CyprusScraper();
    expect(s.country).toBe("CY");
    expect(s.source).toBe("cy_observatory");
  });

  it("posts the form once per fuel with the token and session cookie, as Pumperly", async () => {
    const { CyprusScraper } = await import("./cyprus");
    mockSite({ 1: table(ROWS.decimalA) });
    await new CyprusScraper().fetch();

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    const posts = calls.slice(1).map(([, init]) => init as RequestInit);
    expect(posts.map((p) => new URLSearchParams(String(p.body)).get("Entity.PetroleumType"))).toEqual(["1", "2", "3"]);
    for (const p of posts) {
      const params = new URLSearchParams(String(p.body));
      expect(params.get("__RequestVerificationToken")).toBe("tok123");
      expect(params.get("Entity.StationCityEnum")).toBe("All");
      expect(p.headers).toMatchObject({ "User-Agent": "Pumperly/1.0", Cookie: "ASP.NET_SessionId=abc" });
    }
  });

  it("merges the three fuels onto one station per location and maps them to E5, E5_98, B7", async () => {
    const { CyprusScraper } = await import("./cyprus");
    const bumped = ROWS.decimalA.replace(/>\s*1\.\d{3}\s*</, "> 1.999 <");
    mockSite({ 1: table(ROWS.decimalA, ROWS.decimalB), 2: table(bumped), 3: table(ROWS.decimalA) });
    const { stations, prices } = await new CyprusScraper().fetch();

    expect(stations).toHaveLength(2);
    const esso = stations.find((s) => s.brand === "ESSO")!;
    expect(esso.externalId).toBe("cy-35.18451,33.38950");
    expect(esso.latitude).toBeCloseTo(35.1845138888889, 9);
    expect(esso.city).toBe("Καϊμακλί");
    expect(esso.address).toContain("Καντάρας 58");
    const essoPrices = prices.filter((p) => p.stationExternalId === esso.externalId);
    expect(essoPrices.map((p) => p.fuelType).sort()).toEqual(["B7", "E5", "E5_98"]);
    expect(essoPrices.find((p) => p.fuelType === "E5_98")!.price).toBe(1.999);
    expect(prices.every((p) => p.currency === "EUR")).toBe(true);
  });

  it("places degrees-minutes-seconds stations and skips offline and unlocatable ones", async () => {
    const { CyprusScraper } = await import("./cyprus");
    mockSite({ 1: table(ROWS.dms, ROWS.offline, ROWS.noCoords) });
    const { stations, prices } = await new CyprusScraper().fetch();

    expect(stations).toHaveLength(1);
    expect(stations[0].latitude).toBeCloseTo(34.653750, 5);
    expect(stations[0].longitude).toBeCloseTo(32.974, 3);
    expect(prices).toHaveLength(1);
  });

  it("fails loudly when the form has no token or a POST fails", async () => {
    const { CyprusScraper } = await import("./cyprus");
    mockSite({}, { formOk: false });
    await expect(new CyprusScraper().fetch()).rejects.toThrow("anti-forgery token");
    vi.resetModules();
    const again = await import("./cyprus");
    mockSite({}, { postStatus: 500 });
    await expect(new again.CyprusScraper().fetch()).rejects.toThrow("HTTP 500");
  });
});
