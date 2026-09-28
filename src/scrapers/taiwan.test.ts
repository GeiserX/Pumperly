import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../generated/prisma/client", () => ({ PrismaClient: vi.fn() }));

// Shapes copied from the live CPC feeds, 2026-09-28.
const priceRow = (name: string, amount: number, place = "中油自營站", unit = "元/ 公升") => ({
  型別名稱: "汽柴油零售",
  產品名稱: name,
  交貨地點: place,
  計價單位: unit,
  參考牌價_金額: amount,
  牌價生效日期: "1150928",
});
const PRICES = [
  priceRow("98無鉛汽油", 34.7),
  priceRow("95無鉛汽油", 32.7),
  priceRow("92無鉛汽油", 31.2),
  priceRow("酒精汽油", 32.7),
  priceRow("超級柴油", 29.9),
  priceRow("海運輕柴油", 29900, "中油自營漁船站", "元/ 公秉"),
  priceRow("低硫燃料油(S:0.5%)", 24658, "中油供油服務中心", "元/ 公秉"),
];

function station(overrides: Record<string, unknown> = {}) {
  return {
    站代號: "AA6212A03",
    類別: "加盟站",
    站名: "台東",
    縣市: "台東縣",
    鄉鎮區: "台東市",
    地址: "豐谷里15鄰中華路二段515號",
    營業中: "1",
    無鉛92: 1,
    無鉛95: 1,
    無鉛98: 0,
    酒精汽油: 0,
    超柴: 1,
    經度: 121.1318,
    緯度: 22.7411,
    ...overrides,
  };
}

function mockFeeds(prices: unknown, stations: unknown, status = { prices: 200, stations: 200 }) {
  vi.mocked(fetch).mockImplementation(async (url) => {
    const isPrice = String(url).includes("mainprodlistprice");
    return new Response(JSON.stringify(isPrice ? prices : stations), {
      status: isPrice ? status.prices : status.stations,
    });
  });
}

describe("TaiwanScraper", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("has correct country and source", async () => {
    const { TaiwanScraper } = await import("./taiwan");
    const s = new TaiwanScraper();
    expect(s.country).toBe("TW");
    expect(s.source).toBe("cpc_tw");
  });

  it("reads the lowercase CPC endpoints directly (the mixed-case ones 301)", async () => {
    const { TaiwanScraper } = await import("./taiwan");
    mockFeeds(PRICES, [station()]);
    await new TaiwanScraper().fetch();
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u)).sort();
    expect(urls).toEqual([
      "https://vipmbr.cpc.com.tw/opendata/getstationinfo",
      "https://vipmbr.cpc.com.tw/opendata/mainprodlistprice",
    ]);
  });

  it("gives each station the list price of only the fuels its flags say it sells, never 92 as E10", async () => {
    const { TaiwanScraper } = await import("./taiwan");
    mockFeeds(PRICES, [station()]);
    const { stations, prices } = await new TaiwanScraper().fetch();

    expect(stations).toEqual([
      {
        externalId: "tw-cpc-AA6212A03",
        name: "中油 台東",
        brand: "CPC",
        address: "豐谷里15鄰中華路二段515號",
        city: "台東市",
        province: "台東縣",
        latitude: 22.7411,
        longitude: 121.1318,
        stationType: "fuel",
      },
    ]);
    expect(prices).toEqual([
      { stationExternalId: "tw-cpc-AA6212A03", fuelType: "E5", price: 32.7, currency: "TWD" },
      { stationExternalId: "tw-cpc-AA6212A03", fuelType: "B7", price: 29.9, currency: "TWD" },
    ]);
  });

  it("ignores marine and fuel-oil rows priced per kilolitre", async () => {
    const { TaiwanScraper } = await import("./taiwan");
    mockFeeds(PRICES, [station({ 無鉛98: 1 })]);
    const { prices } = await new TaiwanScraper().fetch();
    expect(prices.map((p) => p.price)).not.toContain(29900);
    expect(prices.find((p) => p.fuelType === "E5_98")!.price).toBe(34.7);
  });

  it("ignores a road-fuel row priced per kilolitre rather than per litre", async () => {
    const { TaiwanScraper } = await import("./taiwan");
    const perKl = [...PRICES.filter((p) => p.產品名稱 !== "超級柴油"), priceRow("超級柴油", 29900, "中油自營站", "元/ 公秉")];
    mockFeeds(perKl, [station()]);
    const { prices } = await new TaiwanScraper().fetch();
    expect(prices.some((p) => p.fuelType === "B7")).toBe(false);
  });

  it("skips stations that are not operating, outside Taiwan, without coordinates or repeated", async () => {
    const { TaiwanScraper } = await import("./taiwan");
    mockFeeds(PRICES, [
      station({ 站代號: "A", 營業中: "3" }),
      station({ 站代號: "B", 緯度: 35.0, 經度: 139.0 }),
      station({ 站代號: "C", 緯度: null }),
      station({ 站代號: "D", 無鉛92: 1, 無鉛95: 0, 無鉛98: 0, 超柴: 0 }),
      station({ 站代號: "E" }),
      station({ 站代號: "E" }),
      null,
      "x",
    ]);
    const { stations } = await new TaiwanScraper().fetch();
    expect(stations.map((s) => s.externalId)).toEqual(["tw-cpc-E"]);
  });

  it("throws on HTTP errors, non-array payloads, or a price list with no road fuels", async () => {
    const { TaiwanScraper } = await import("./taiwan");
    mockFeeds(PRICES, [station()], { prices: 503, stations: 200 });
    await expect(new TaiwanScraper().fetch()).rejects.toThrow("HTTP 503");
    mockFeeds({ rows: PRICES }, [station()]);
    await expect(new TaiwanScraper().fetch()).rejects.toThrow("not an array");
    mockFeeds([priceRow("海運輕柴油", 29900, "中油自營漁船站", "元/ 公秉")], [station()]);
    await expect(new TaiwanScraper().fetch()).rejects.toThrow("none of the road fuels");
  });
});
