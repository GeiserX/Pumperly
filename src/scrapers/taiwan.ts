import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// Taiwan — CPC Corporation open data (data.gov.tw datasets 6339 and 6065)
// ---------------------------------------------------------------------------
// CPC publishes its official pump list prices and the full list of its ~1,970
// stations (company-owned and franchise) with WGS84 coordinates and a flag per
// fuel sold. The list price is set nationally and changes weekly, so every CPC
// station gets the list price for each fuel its flags say it sells.
// Franchise stations may discount below it; the list price is still the price
// posted at the pump for most of them.
//
// Licence: Open Government Data License, version 1.0 (reuse with attribution).
// Formosa Petrochemical stations are not in this feed.
//
// Fuel mapping follows the repo convention for national grades: 95 → E5,
// 98 → E5_98, super diesel → B7, and the regular 92 grade → E10 (as the WA
// scraper does for 91 RON). 酒精汽油 (E3 ethanol blend, 14 stations) is skipped.
// ---------------------------------------------------------------------------

const PRICE_URL = "https://vipmbr.cpc.com.tw/opendata/mainprodlistprice";
const STATION_URL = "https://vipmbr.cpc.com.tw/opendata/getstationinfo";

// Taiwan incl. Penghu, Kinmen and Matsu
const LAT_MIN = 21.8;
const LAT_MAX = 26.4;
const LON_MIN = 118.1;
const LON_MAX = 122.1;

/** Product name in the price list → station flag → harmonised fuel type. */
const PRODUCTS: ReadonlyArray<{ product: string; flag: string; fuelType: FuelType }> = [
  { product: "92無鉛汽油", flag: "無鉛92", fuelType: "E10" },
  { product: "95無鉛汽油", flag: "無鉛95", fuelType: "E5" },
  { product: "98無鉛汽油", flag: "無鉛98", fuelType: "E5_98" },
  { product: "超級柴油", flag: "超柴", fuelType: "B7" },
];

interface CpcPrice {
  產品名稱: string;
  交貨地點: string;
  計價單位: string;
  參考牌價_金額: number | string;
}

type CpcStation = Record<string, unknown> & {
  站代號: string;
  類別: string;
  站名: string;
  縣市: string;
  鄉鎮區: string;
  地址: string;
  營業中: string | number;
  經度: number | string;
  緯度: number | string;
};

const HEADERS = { Accept: "application/json", "User-Agent": "Pumperly/1.0" };

export class TaiwanScraper extends BaseScraper {
  readonly country = "TW";
  readonly source = "cpc_tw";

  /** Read CPC's list prices and station list and give each station its fuels at list price. */
  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const [priceRes, stationRes] = await Promise.all([
      fetch(PRICE_URL, { headers: HEADERS, signal: AbortSignal.timeout(30_000) }),
      fetch(STATION_URL, { headers: HEADERS, signal: AbortSignal.timeout(60_000) }),
    ]);
    if (!priceRes.ok) throw new Error(`CPC price list returned HTTP ${priceRes.status}`);
    if (!stationRes.ok) throw new Error(`CPC station list returned HTTP ${stationRes.status}`);

    const priceData: unknown = await priceRes.json();
    const stationData: unknown = await stationRes.json();
    if (!Array.isArray(priceData)) throw new Error("CPC price list is not an array");
    if (!Array.isArray(stationData)) throw new Error("CPC station list is not an array");

    // Road-fuel list prices only: sold at CPC's own stations, priced per litre.
    const listPrice = new Map<string, number>();
    for (const raw of priceData) {
      if (raw === null || typeof raw !== "object") continue;
      const p = raw as CpcPrice;
      if (p.交貨地點?.trim() !== "中油自營站") continue;
      if (!String(p.計價單位 ?? "").replace(/\s/g, "").includes("元/公升")) continue;
      const value = Number(p.參考牌價_金額);
      if (!isFinite(value) || value <= 0) continue;
      listPrice.set(String(p.產品名稱).trim(), value);
    }
    const products = PRODUCTS.filter((p) => listPrice.has(p.product));
    if (products.length === 0) throw new Error("CPC price list has none of the road fuels");
    console.log(`[${this.source}] List prices: ${products.map((p) => `${p.product}=${listPrice.get(p.product)}`).join(", ")}`);

    const stations: RawStation[] = [];
    const prices: RawFuelPrice[] = [];
    const seen = new Set<string>();

    for (const raw of stationData) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const s = raw as CpcStation;
      const id = typeof s.站代號 === "string" ? s.站代號.trim() : "";
      if (!id || seen.has(id)) continue;
      if (String(s.營業中) !== "1") continue;

      const lat = Number(s.緯度);
      const lon = Number(s.經度);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) continue;

      const sold = products.filter((p) => String(s[p.flag]) === "1");
      if (sold.length === 0) continue;
      seen.add(id);

      const externalId = `tw-cpc-${id}`;
      const name = typeof s.站名 === "string" && s.站名.trim() ? s.站名.trim() : id;
      stations.push({
        externalId,
        name: `中油 ${name}`,
        brand: "CPC",
        address: typeof s.地址 === "string" ? s.地址.trim() : "",
        city: typeof s.鄉鎮區 === "string" ? s.鄉鎮區.trim() : "",
        province: typeof s.縣市 === "string" && s.縣市.trim() ? s.縣市.trim() : null,
        latitude: lat,
        longitude: lon,
        stationType: "fuel",
      });
      for (const p of sold) {
        prices.push({
          stationExternalId: externalId,
          fuelType: p.fuelType,
          price: listPrice.get(p.product)!,
          currency: "TWD",
        });
      }
    }

    console.log(`[${this.source}] Processed ${stations.length} stations, ${prices.length} prices`);
    return { stations, prices };
  }
}
