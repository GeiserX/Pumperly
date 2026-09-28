import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// Cyprus — Consumer Protection Service Retail Fuel Price Observatory
// ---------------------------------------------------------------------------
// Government observatory listing every station's current pump price, one fuel
// per form submission (data.gov.cy dataset 432, CC BY-SA 4.0: attribute the
// Consumer Protection Service and share derived data alike). robots.txt allows
// everything.
//
// It is an ASP.NET MVC form: GET the page for the anti-forgery token and the
// session cookie, then POST once per fuel. Each <tr> carries brand, company,
// address (whose link holds the coordinates), village and price.
//
// Traps, all verified on the live page:
// - The HTML has no station id. Stations are keyed on their coordinates,
//   rounded to 5 decimals (~1 m); no two stations share one.
// - About a sixth of the coordinates are degrees-minutes-seconds
//   (34°39'13.5"N 32°58'26.3"E), the rest decimal, sometimes with a space.
// - Stations marked `isOffLine` have stopped reporting; their price may be
//   stale, so they are skipped.
// ---------------------------------------------------------------------------

const PAGE_URL = "https://eforms.eservices.cyprus.gov.cy/MCIT/MCIT/PetroleumPrices";

const FUELS: ReadonlyArray<{ type: number; fuelType: FuelType }> = [
  { type: 1, fuelType: "E5" }, // Unleaded 95
  { type: 2, fuelType: "E5_98" }, // Unleaded 98
  { type: 3, fuelType: "B7" }, // Diesel
];

// Whole island, incl. the areas the observatory does not cover
const LAT_MIN = 34.4;
const LAT_MAX = 35.8;
const LON_MIN = 32.2;
const LON_MAX = 34.7;

const UA = "Pumperly/1.0";

/** Decode the HTML entities that appear in the observatory's table cells. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Strip tags and collapse whitespace in a table cell. */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Parse the `coordinates=` value of a DisplayMap link into [lat, lon].
 * Accepts "35.18,33.38", "34.92 33.44" and "34°39'13.5"N 32°58'26.3"E".
 */
export function parseCyprusCoordinates(raw: string): [number, number] | null {
  let text: string;
  try {
    text = decodeURIComponent(decodeEntities(raw));
  } catch {
    return null;
  }
  const dec = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (dec) return [Number(dec[1]), Number(dec[2])];

  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*°\s*(\d+(?:\.\d+)?)\s*['′]\s*(\d+(?:\.\d+)?)\s*["″]?\s*([NSEW])/g)];
  if (parts.length !== 2) return null;
  let lat: number | null = null;
  let lon: number | null = null;
  for (const [, d, m, s, hemi] of parts) {
    const v = Number(d) + Number(m) / 60 + Number(s) / 3600;
    if (hemi === "N" || hemi === "S") lat = hemi === "S" ? -v : v;
    else lon = hemi === "W" ? -v : v;
  }
  return lat === null || lon === null ? null : [lat, lon];
}

interface ParsedRow {
  brand: string;
  company: string;
  address: string;
  village: string;
  price: number;
  lat: number;
  lon: number;
}

/** Turn one observatory results page into rows, dropping offline and unlocatable stations. */
export function parseCyprusTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const [, tr] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (tr.includes("isOffLine")) continue;
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 5) continue;
    const coords = tr.match(/coordinates=([^"'&]+)/);
    if (!coords) continue;
    const ll = parseCyprusCoordinates(coords[1]);
    if (!ll) continue;
    const [lat, lon] = ll;
    if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) continue;
    const price = Number(cellText(cells[4]).replace(",", "."));
    if (!isFinite(price) || price <= 0) continue;
    rows.push({
      brand: cellText(cells[0]),
      company: cellText(cells[1]),
      address: cellText(cells[2]),
      village: cellText(cells[3]),
      price,
      lat,
      lon,
    });
  }
  return rows;
}

/** Pull the session cookie out of a response so the POST can reuse it. */
function cookiesFrom(res: Response): string {
  const all = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  return all.map((c) => c.split(";")[0]).join("; ");
}

export class CyprusScraper extends BaseScraper {
  readonly country = "CY";
  readonly source = "cy_observatory";

  /** Submit the observatory form once per fuel and merge the results by station coordinates. */
  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const page = await fetch(PAGE_URL, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!page.ok) throw new Error(`Cyprus observatory returned HTTP ${page.status}`);
    const cookie = cookiesFrom(page);
    const form = await page.text();
    const token = form.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
    if (!token) throw new Error("Cyprus observatory form has no anti-forgery token");

    const stations = new Map<string, RawStation>();
    const prices: RawFuelPrice[] = [];

    for (const { type, fuelType } of FUELS) {
      const body = new URLSearchParams({
        __RequestVerificationToken: token,
        "Entity.PetroleumType": String(type),
        "Entity.StationCityEnum": "All",
        "Entity.StationDistrict": "",
      });
      const res = await fetch(PAGE_URL, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body.toString(),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Cyprus observatory POST for fuel ${type} returned HTTP ${res.status}`);
      const rows = parseCyprusTable(await res.text());
      console.log(`[${this.source}] ${fuelType}: ${rows.length} online stations`);

      for (const r of rows) {
        const externalId = `cy-${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
        if (!stations.has(externalId)) {
          stations.set(externalId, {
            externalId,
            name: [r.brand, r.village].filter(Boolean).join(" ") || r.company || externalId,
            brand: r.brand || null,
            address: r.address,
            city: r.village,
            province: null,
            latitude: r.lat,
            longitude: r.lon,
            stationType: "fuel",
          });
        }
        prices.push({ stationExternalId: externalId, fuelType, price: r.price, currency: "EUR" });
      }
    }

    console.log(`[${this.source}] Processed ${stations.size} stations, ${prices.length} prices`);
    return { stations: [...stations.values()], prices };
  }
}
