import { z } from "zod";
import type { EvFees, SessionFeeRule } from "../types/station";
import {
  BaseScraper,
  isPlausibleEvPrice,
  maxSanePowerKw,
  type RawFuelPrice,
  type RawStation,
  type ScraperResult,
} from "./base";
import { otherGermanyEvPrefixes } from "./germany-ev-source";

// ---------------------------------------------------------------------------
// OCPDB (Open ChargePoint Database) via MobiData BW — German EV chargers + prices
// ---------------------------------------------------------------------------
// API:     https://api.mobidata-bw.de/ocpdb/api/ocpi/3.0/{locations,tariffs,tariff-associations}
//          (the central api.ocpdb.de only serves the map UI; its OCPI paths 404)
// Sources: the BNetzA register (`bnetza_api`) merged with the operators' own
//          DATEX II feeds from Mobilithek (EnBW, EcoMovement, Chargecloud,
//          Wirelane, e-clearing.net, Tesla, ...). Freshness per source:
//          /ocpdb/api/public/v1/sources
// Licence: BNetzA and EnBW are CC BY 4.0, the other feeds CC0 (see
//          components/nav/legal-modal.tsx). No API key, no signup.
//
// Replaces the BNetzA scraper as Germany's default EV source: same register,
// plus ad-hoc tariffs for ~97k EVSEs, which BNetzA does not publish.
//
// THREE THINGS SHAPE THIS FILE.
//
// 1. The feeds overlap. A charger the operator reports over DATEX II is often
//    also in the register, under a different operator name (site owner vs
//    CPO) and with coordinates a few metres off. Measured on 2026-10-22:
//    ~4.7k EcoMovement and ~4.9k Chargecloud locations sit within 25 m of a
//    register location, many at 0 m. Hence mergeLocations(): a 25 m greedy
//    merge, register first so its coordinates anchor the pins.
//
// 2. VAT is inconsistent across feeds. EcoMovement and EnBW publish net
//    prices with `taxes: [VAT 19%]` and `tax_included: false`, Wirelane
//    publishes gross, Chargecloud publishes no tax data at all. Ad-hoc
//    charging is a consumer price and PAngV requires it gross, so "no tax
//    data" is read as gross. A price marked net with no rate gets German
//    VAT. See grossPrice().
//
// 3. TIME components read as per minute here, not OCPI's per hour. Every
//    one seen is a blocking fee starting 30-240 min in (EnBW 0.2017 net
//    after 30 min, Wirelane 0.20 after 45 min, Chargecloud 0.06 after
//    4 h). Those match the per-minute blocking fees operators advertise.
//    Per hour they would be too small to block anyone.
//
// Like bnetza.ts, run() sweeps afterwards, because base.run() never
// garbage-collects EV rows.
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.mobidata-bw.de/ocpdb/api/ocpi/3.0";

// Hard upstream cap: a larger limit is a 400.
const PAGE_SIZE = 1000;
const CONCURRENCY = 4;
const PAGE_TIMEOUT_MS = 120_000;

// Germany's bounding box, padded. Same as bnetza.ts.
const DE_BBOX = { latMin: 47, latMax: 56, lonMin: 5.5, lonMax: 15.5 };

/** Locations closer than this fold into one pin. */
const MERGE_RADIUS_M = 25;
// Grid cell for the merge lookup, in degrees. ~111 m of latitude, so a 3×3
// neighbourhood always covers the merge radius.
const GRID_DEG = 0.001;

// Baked into every externalId. Changing it re-mints every row.
const COORD_PRECISION = 5;

// Lower rank wins the anchor. The register first: its coordinates are the
// official ones and it covers every operator. Then the feeds that carry
// prices, so a priced pin keeps the operator's own name when the register has
// no entry nearby.
const SOURCE_RANK: Record<string, number> = {
  bnetza_api: 0,
  datex2_enbw: 1,
  datex2_ecomovement: 2,
  datex2_chargecloud: 3,
  datex2_wirelane: 4,
};
const DEFAULT_RANK = 9;

// EVSEs in these states are not a charger anyone can drive to.
const DEAD_EVSE_STATUSES = new Set(["REMOVED", "PLANNED"]);

// German standard VAT, for prices marked net that don't say at what rate.
const DE_VAT_PCT = 19;

// Session size used to fold a session fee into a per-kWh figure when ranking
// tariffs: a typical fast-charge top-up.
const REF_SESSION_KWH = 30;

// A feed whose static data hasn't refreshed in this long, or that OCPDB marks
// as failed, has its tariffs ignored: its last prices would otherwise stay on
// the map indefinitely. Per-source, not per-tariff: a tariff's last_updated is
// when its price last changed, and most valid ones are months old.
const rawMaxFeedAge = Number(process.env.PUMPERLY_OCPDB_MAX_FEED_AGE_DAYS ?? "3");
const MAX_FEED_AGE_DAYS = Number.isFinite(rawMaxFeedAge) && rawMaxFeedAge > 0 ? rawMaxFeedAge : 3;

// Same floor as bnetza.ts, for the same reasons: a degraded fetch
// must not be able to bulk-delete yesterday's map or retire the other sources.
const rawMinStations = Number(process.env.PUMPERLY_OCPDB_MIN_STATIONS ?? "10000");
const MIN_STATIONS =
  Number.isFinite(rawMinStations) && rawMinStations >= 1 ? Math.floor(rawMinStations) : 10_000;

// ---------------------------------------------------------------------------
// Upstream shapes. Only the fields used; everything else passes through.
// ---------------------------------------------------------------------------

const TaxSchema = z.object({ percentage: z.coerce.number() });

const PriceComponentSchema = z.object({
  type: z.string(),
  price: z.number(),
  taxes: z.array(TaxSchema).optional(),
  tax_included: z.boolean().optional(),
});

const TariffSchema = z.object({
  id: z.string(),
  source: z.string(),
  currency: z.string(),
  tax_included: z.string().nullish(),
  elements: z.array(
    z.object({
      price_components: z.array(PriceComponentSchema),
      restrictions: z
        .object({
          min_duration: z.number().nullish(),
          // Only shown as text, so an odd value drops the detail, not the tariff.
          start_time: z.string().nullish().catch(null),
          end_time: z.string().nullish().catch(null),
          day_of_week: z.array(z.string()).nullish().catch(null),
        })
        .passthrough()
        .nullish(),
    }),
  ),
});

const AssociationSchema = z.object({
  tariff_id: z.string(),
  audience: z.string().nullish(),
  evses: z.array(z.object({ evse_uid: z.string() })).default([]),
});

const LocationSchema = z.object({
  source: z.string(),
  country: z.string(),
  name: z.string().nullish(),
  address: z.string().nullish(),
  postal_code: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  coordinates: z.object({ latitude: z.number(), longitude: z.number() }),
  operator: z.object({ name: z.string().nullish() }).nullish(),
  charging_pool: z
    .array(
      z.object({
        evses: z
          .array(
            z.object({
              uid: z.string(),
              status: z.string().nullish(),
              connectors: z
                .array(z.object({ max_electric_power: z.number().nullish() }))
                .default([]),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

const SourceSchema = z.object({
  uid: z.string(),
  static_status: z.string().nullish(),
  static_data_updated_at: z.string().nullish(),
});

export type OcpdbSource = z.infer<typeof SourceSchema>;
export type OcpdbTariff = z.infer<typeof TariffSchema>;
export type OcpdbAssociation = z.infer<typeof AssociationSchema>;
export type OcpdbLocation = z.infer<typeof LocationSchema>;
type PriceComponent = z.infer<typeof PriceComponentSchema>;

// ---------------------------------------------------------------------------
// Tariffs
// ---------------------------------------------------------------------------

export interface TariffSummary {
  /** Gross price per kWh. */
  energy: number;
  currency: string;
  fees: EvFees;
  /** When the tariff's feed last refreshed, if known. */
  reportedAt?: Date;
}

/** A component's price with VAT, rounded to 4 dp. See header note 2. */
export function grossPrice(component: PriceComponent, tariff: Pick<OcpdbTariff, "tax_included">): number {
  const included = component.tax_included ?? (tariff.tax_included === "NO" ? false : true);
  // Marked net but no rate given: the price is still net, so add German VAT.
  const vat = included
    ? 0
    : component.taxes?.length
      ? component.taxes.reduce((sum, t) => sum + t.percentage, 0)
      : DE_VAT_PCT;
  return Math.round(component.price * (1 + vat / 100) * 10_000) / 10_000;
}

/**
 * What ranks tariffs against each other: €/kWh with the session fee spread
 * over a typical session, so a low rate can't hide a large fee.
 */
export function effectivePerKwh(s: TariffSummary): number {
  return s.energy + (s.fees.sessionFee ?? 0) / REF_SESSION_KWH;
}

function cheaper(a: TariffSummary, b: TariffSummary | null | undefined): boolean {
  return !b || effectivePerKwh(a) < effectivePerKwh(b);
}

/**
 * Reduce a tariff to what a pin can show: gross €/kWh plus the fees on top.
 * Null when the tariff has no per-kWh price (a flat- or time-only tariff
 * cannot be ranked against the rest).
 */
export function summarizeTariff(tariff: OcpdbTariff): TariffSummary | null {
  let energy: number | null = null;
  // FLAT fees in unrestricted elements always apply, so they add up. Restricted
  // ones (by time of day, weekday...) are alternatives: each becomes a rule the
  // popup lists, and the highest fee is the one cost estimates use.
  let sessionFee = 0;
  const rules: SessionFeeRule[] = [];
  let perMinute: { price: number; afterSec: number } | null = null;

  for (const element of tariff.elements) {
    const afterSec = element.restrictions?.min_duration ?? 0;
    const restricted = Object.values(element.restrictions ?? {}).some((v) => v != null);
    for (const c of element.price_components) {
      const price = grossPrice(c, tariff);
      if (c.type === "ENERGY") {
        // Restricted energy prices (by duration, power...) are the exception;
        // the first one listed is the headline rate.
        if (energy == null) energy = price;
      } else if (c.type === "FLAT") {
        if (!restricted) sessionFee += price;
        else rules.push(feeRule(price, element.restrictions ?? {}));
      } else if (c.type === "TIME" && price > 0) {
        // Several TIME steps: the first one that costs anything is the fee
        // a driver will actually meet.
        if (perMinute == null || afterSec < perMinute.afterSec) perMinute = { price, afterSec };
      }
    }
  }

  if (energy == null) return null;
  const fees: EvFees = {};
  const highest = Math.max(sessionFee, ...rules.map((r) => r.fee));
  if (highest > 0) {
    fees.sessionFee = round4(highest);
    // A restricted fee equal to the always-on one changes nothing (some feeds
    // repeat their elements under a min_duration), so it isn't listed.
    const always = round4(sessionFee);
    const varying = rules.filter((r) => r.fee !== always);
    if (varying.length > 0) fees.sessionFeeRules = always > 0 ? [{ fee: always }, ...varying] : varying;
  }
  if (perMinute) {
    fees.perMinute = perMinute.price;
    fees.afterMin = Math.round(perMinute.afterSec / 60);
  }
  return { energy, currency: tariff.currency, fees };
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

const ISO_DAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
const SHOWN_RESTRICTIONS = new Set(["start_time", "end_time", "day_of_week"]);

/** When a restricted session fee applies, in the shape the popup prints. */
function feeRule(price: number, r: NonNullable<OcpdbTariff["elements"][number]["restrictions"]>): SessionFeeRule {
  const rule: SessionFeeRule = { fee: round4(price) };
  if (r.start_time) rule.from = r.start_time;
  if (r.end_time) rule.to = r.end_time;
  const days = (r.day_of_week ?? []).map((d) => ISO_DAYS.indexOf(d) + 1).filter((d) => d > 0);
  if (days.length > 0) rule.days = days;
  if (Object.entries(r).some(([k, v]) => v != null && !SHOWN_RESTRICTIONS.has(k))) rule.other = true;
  return rule;
}

/**
 * The feeds whose tariffs can be trusted, each with when it last refreshed:
 * OCPDB reports them ACTIVE and their static data (which carries the tariffs)
 * refreshed within `maxAgeDays`.
 */
export function liveSources(sources: OcpdbSource[], now: Date, maxAgeDays: number): Map<string, Date> {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const live = new Map<string, Date>();
  for (const s of sources) {
    const updated = Date.parse(s.static_data_updated_at ?? "");
    if (s.static_status === "ACTIVE" && updated >= cutoff) live.set(s.uid, new Date(updated));
  }
  return live;
}

/**
 * EVSE uid → cheapest ad-hoc tariff on it. Only AD_HOC_PAYMENT counts (an
 * association with no audience doesn't): that is the price a driver without a
 * contract pays, the only one comparable across operators. Tariffs the map
 * would reject (see isPlausibleEvPrice) are dropped before ranking, so a bogus
 * 0.00 can't hide a valid price. With `live`, tariffs from any other feed are
 * dropped too, and the rest carry their feed's refresh time.
 */
export function evseTariffs(
  tariffs: OcpdbTariff[],
  associations: OcpdbAssociation[],
  live?: Map<string, Date>,
): Map<string, TariffSummary> {
  const byId = new Map<string, TariffSummary>();
  for (const t of tariffs) {
    if (live && !live.has(t.source)) continue;
    const s = summarizeTariff(t);
    if (!s || !isPlausibleEvPrice(s.energy, s.currency)) continue;
    const reportedAt = live?.get(t.source);
    byId.set(t.id, reportedAt ? { ...s, reportedAt } : s);
  }
  const byEvse = new Map<string, TariffSummary>();
  for (const a of associations) {
    if (a.audience !== "AD_HOC_PAYMENT") continue;
    const s = byId.get(a.tariff_id);
    if (!s) continue;
    for (const { evse_uid } of a.evses) {
      if (cheaper(s, byEvse.get(evse_uid))) byEvse.set(evse_uid, s);
    }
  }
  return byEvse;
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** The merge anchor's key, which is also the externalId. */
export function stationKey(latitude: number, longitude: number): string {
  return `ocpdb-${latitude.toFixed(COORD_PRECISION)}_${longitude.toFixed(COORD_PRECISION)}`;
}

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export interface OcpdbParseStats {
  locations: number;
  notGermany: number;
  noLiveEvse: number;
  merged: number;
  priced: number;
}

interface Pin {
  station: RawStation;
  tariff: TariffSummary | null;
  /** The location's own name or street, which the pin's name is built from. */
  site: string;
}

/** "Operator — site", falling back to whichever part exists, then the key. */
function pinName(operator: string | null, site: string, key: string): string {
  return [operator, site].filter(Boolean).join(" — ") || key;
}

/**
 * Turn OCPDB locations into deduplicated pins, each with its cheapest ad-hoc
 * tariff. A pin is labelled with the operator whose tariff it shows: when a
 * merged location supplies the price, its operator takes over the brand, so a
 * driver never sees one operator's name next to another's price. Pure: the merge, the filters and the derived externalId all live
 * here, so this is what the tests cover.
 */
export function mergeLocations(
  locations: OcpdbLocation[],
  tariffsByEvse: Map<string, TariffSummary>,
): { stations: RawStation[]; prices: RawFuelPrice[]; stats: OcpdbParseStats } {
  const stats: OcpdbParseStats = { locations: locations.length, notGermany: 0, noLiveEvse: 0, merged: 0, priced: 0 };

  // Stable sort: equal ranks keep upstream order, so the anchors (and the
  // externalIds) don't shuffle between runs.
  const ordered = locations
    .map((loc, i) => ({ loc, i, rank: SOURCE_RANK[loc.source] ?? DEFAULT_RANK }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.loc);

  const grid = new Map<string, Pin[]>();
  const pins: Pin[] = [];
  const cell = (lat: number, lon: number) => `${Math.floor(lat / GRID_DEG)}:${Math.floor(lon / GRID_DEG)}`;

  for (const loc of ordered) {
    const { latitude, longitude } = loc.coordinates;
    if (
      loc.country !== "DEU" ||
      latitude < DE_BBOX.latMin ||
      latitude > DE_BBOX.latMax ||
      longitude < DE_BBOX.lonMin ||
      longitude > DE_BBOX.lonMax
    ) {
      stats.notGermany++;
      continue;
    }

    const evses = loc.charging_pool
      .flatMap((p) => p.evses)
      .filter((e) => !DEAD_EVSE_STATUSES.has(e.status ?? ""));
    if (evses.length === 0) {
      stats.noLiveEvse++;
      continue;
    }

    // max_electric_power is in W.
    const powerKw = maxSanePowerKw(
      evses.flatMap((e) => e.connectors.map((c) => (c.max_electric_power ?? 0) / 1000)),
    );
    let tariff: TariffSummary | null = null;
    for (const e of evses) {
      const t = tariffsByEvse.get(e.uid);
      if (t && cheaper(t, tariff)) tariff = t;
    }
    const operator = loc.operator?.name?.trim() || null;

    // Fold into an existing pin within the merge radius, if any.
    const gy = Math.floor(latitude / GRID_DEG);
    const gx = Math.floor(longitude / GRID_DEG);
    let target: Pin | null = null;
    let best = MERGE_RADIUS_M;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const pin of grid.get(`${gy + dy}:${gx + dx}`) ?? []) {
          const d = distanceM(pin.station.latitude, pin.station.longitude, latitude, longitude);
          if (d <= best) {
            best = d;
            target = pin;
          }
        }
      }
    }

    if (target) {
      stats.merged++;
      if (powerKw != null && powerKw > (target.station.maxPowerKw ?? 0)) target.station.maxPowerKw = powerKw;
      if (tariff && cheaper(tariff, target.tariff)) {
        target.tariff = tariff;
        if (operator) {
          target.station.brand = operator;
          target.station.name = pinName(operator, target.site, target.station.externalId);
        }
      }
      continue;
    }

    const key = stationKey(latitude, longitude);
    const street = loc.address?.trim() ?? "";
    const postcode = loc.postal_code?.trim() ?? "";
    const site = loc.name?.trim() || street;
    const name = pinName(operator, site, key);
    const pin: Pin = {
      station: {
        externalId: key,
        name,
        brand: operator,
        address: [street, postcode].filter(Boolean).join(", ") || name,
        city: loc.city?.trim() ?? "",
        province: loc.state?.trim() || null,
        latitude,
        longitude,
        stationType: "ev_charger",
        maxPowerKw: powerKw,
      },
      tariff,
      site,
    };
    pins.push(pin);
    const k = cell(latitude, longitude);
    const bucket = grid.get(k);
    if (bucket) bucket.push(pin);
    else grid.set(k, [pin]);
  }

  const prices: RawFuelPrice[] = [];
  for (const { station, tariff } of pins) {
    if (!tariff) continue;
    stats.priced++;
    prices.push({
      stationExternalId: station.externalId,
      fuelType: "EV",
      price: tariff.energy,
      currency: tariff.currency,
      ...(Object.keys(tariff.fees).length > 0 ? { evFees: tariff.fees } : {}),
      ...(tariff.reportedAt ? { reportedAt: tariff.reportedAt } : {}),
    });
  }

  return { stations: pins.map((p) => p.station), prices, stats };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const PageSchema = z.object({
  items: z.array(z.unknown()),
  total_count: z.number(),
});

async function fetchPage(path: string, offset: number): Promise<z.infer<typeof PageSchema>> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${BASE_URL}/${path}${sep}limit=${PAGE_SIZE}&offset=${offset}`;
  let lastErr: unknown;
  // One retry: a single slow page should not cost the whole run.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "Pumperly/1.0 (+https://pumperly.com)" },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`OCPDB HTTP ${res.status} for ${path} @${offset}`);
      return PageSchema.parse(await res.json());
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Every item of a paginated collection, each parsed with `schema`. Items that
 * fail to parse are counted and skipped, not fatal: one odd location must not
 * cost the country.
 */
async function fetchAll<T>(path: string, schema: z.ZodType<T>): Promise<{ items: T[]; invalid: number }> {
  const first = await fetchPage(path, 0);
  const offsets: number[] = [];
  for (let o = PAGE_SIZE; o < first.total_count; o += PAGE_SIZE) offsets.push(o);

  const pages: unknown[][] = [first.items];
  for (let i = 0; i < offsets.length; i += CONCURRENCY) {
    const batch = await Promise.all(offsets.slice(i, i + CONCURRENCY).map((o) => fetchPage(path, o)));
    for (const p of batch) pages.push(p.items);
  }

  const items: T[] = [];
  let invalid = 0;
  for (const page of pages) {
    for (const raw of page) {
      const r = schema.safeParse(raw);
      if (r.success) items.push(r.data);
      else invalid++;
    }
  }
  return { items, invalid };
}

/**
 * Feed health from OCPDB's own status endpoint (not paginated, ~15 rows).
 * Retried once like a page: a failure here costs the whole run.
 */
async function fetchSources(): Promise<OcpdbSource[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("https://api.mobidata-bw.de/ocpdb/api/public/v1/sources", {
        headers: { Accept: "application/json", "User-Agent": "Pumperly/1.0 (+https://pumperly.com)" },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`OCPDB HTTP ${res.status} for sources`);
      return z.object({ items: z.array(SourceSchema) }).parse(await res.json()).items;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export class OcpdbScraper extends BaseScraper {
  readonly country = "DE";
  readonly source = "ocpdb";

  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const [sources, tariffs, associations, locations] = await Promise.all([
      // Without feed health no tariff can be vouched for, and a run without
      // prices would wipe the current ones: failing here keeps them.
      fetchSources(),
      fetchAll("tariffs", TariffSchema),
      fetchAll("tariff-associations", AssociationSchema),
      fetchAll("locations?country=DEU", LocationSchema),
    ]);
    const live = liveSources(sources, new Date(), MAX_FEED_AGE_DAYS);
    const stale = [...new Set(tariffs.items.map((t) => t.source))].filter((s) => !live.has(s));
    if (stale.length > 0) {
      console.warn(
        `[${this.source}] DE: ignoring tariffs from ${stale.join(", ")} ` +
          `(failed, or no refresh in ${MAX_FEED_AGE_DAYS} days)`,
      );
    }
    const tariffsByEvse = evseTariffs(tariffs.items, associations.items, live);
    const { stations, prices, stats } = mergeLocations(locations.items, tariffsByEvse);

    console.log(
      `[${this.source}] DE: ${tariffs.items.length} tariffs → ${tariffsByEvse.size} priced EVSEs; ` +
        `${stats.locations} locations → ${stations.length} stations, ${stats.priced} priced ` +
        `(merged ${stats.merged}, skipped ${stats.noLiveEvse} without live EVSE, ${stats.notGermany} outside DE, ` +
        `${tariffs.invalid + associations.invalid + locations.invalid} unparseable)`,
    );

    return { stations, prices };
  }

  /**
   * Run the normal pipeline, then sweep (see BaseScraper.sweepEvRows): stale
   * `ocpdb-` rows, and the other German EV sources' rows this one replaces.
   * Germany has exactly one EV source at a time (germany-ev-source.ts), so
   * once OCPDB has landed those are pure duplicates.
   */
  async run(): Promise<ScraperResult> {
    const result = await super.run();
    if (result.errors.length > 0) return result;

    try {
      await this.sweepEvRows({
        ownPrefix: "ocpdb-",
        retirePrefixes: otherGermanyEvPrefixes("ocpdb-"),
        minStations: MIN_STATIONS,
        runDurationMs: result.durationMs,
        label: "OCPDB",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.source}] Cleanup failed: ${msg}`);
      result.errors.push(`Cleanup: ${msg}`);
    }
    return result;
  }
}
