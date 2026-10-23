import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../generated/prisma/client", () => ({ PrismaClient: vi.fn() }));

const { grossPrice, summarizeTariff, effectivePerKwh, evseTariffs, liveSources, mergeLocations, stationKey } =
  await import("./ocpdb");
type Tariff = Parameters<typeof summarizeTariff>[0];
type Location = Parameters<typeof mergeLocations>[0][number];

// Shaped like the live EnBW tariff 132614: net prices, 19% VAT, a per-minute
// blocking fee after 30 minutes.
const ENBW: Tariff = {
  id: "132614",
  source: "datex2_enbw",
  currency: "EUR",
  tax_included: "NO",
  elements: [
    {
      price_components: [
        { type: "ENERGY", price: 0.66386555, taxes: [{ percentage: 19 }], tax_included: false },
      ],
    },
    {
      price_components: [{ type: "TIME", price: 0.20168067, taxes: [{ percentage: 19 }], tax_included: false }],
      restrictions: { min_duration: 1800 },
    },
  ],
};

// Shaped like Chargecloud: no tax data at all, a session fee, free TIME steps.
const CHARGECLOUD: Tariff = {
  id: "133293",
  source: "datex2_chargecloud",
  currency: "EUR",
  elements: [
    { price_components: [{ type: "FLAT", price: 1.5 }] },
    { price_components: [{ type: "ENERGY", price: 0.46 }] },
    { price_components: [{ type: "TIME", price: 0 }] },
    { price_components: [{ type: "TIME", price: 0.06 }], restrictions: { min_duration: 14400 } },
  ],
};

function location(overrides: Partial<Location> & { lat?: number; lon?: number; evses?: string[] } = {}): Location {
  const { lat = 48.7758, lon = 9.1829, evses = ["e1"], ...rest } = overrides;
  return {
    source: "bnetza_api",
    country: "DEU",
    name: null,
    address: "Königstraße 1",
    postal_code: "70173",
    city: "Stuttgart",
    state: "Baden-Württemberg",
    coordinates: { latitude: lat, longitude: lon },
    operator: { name: "EnBW mobility+ AG und Co.KG" },
    charging_pool: [
      { evses: evses.map((uid) => ({ uid, status: "AVAILABLE", connectors: [{ max_electric_power: 22000 }] })) },
    ],
    ...rest,
  };
}

// ~0.00009° of latitude is 10 m.
const METRES = 1 / 111_320;

describe("grossPrice", () => {
  it("adds VAT to a net component", () => {
    expect(grossPrice(ENBW.elements[0].price_components[0], ENBW)).toBe(0.79);
  });

  it("leaves a component that includes tax alone", () => {
    expect(
      grossPrice({ type: "ENERGY", price: 0.79, taxes: [{ percentage: 19 }], tax_included: true }, { tax_included: "YES" }),
    ).toBe(0.79);
  });

  it("reads no tax data as gross", () => {
    expect(grossPrice({ type: "ENERGY", price: 0.46 }, { tax_included: null })).toBe(0.46);
  });

  it("falls back to the tariff's flag when the component has none", () => {
    expect(grossPrice({ type: "ENERGY", price: 0.5, taxes: [{ percentage: 19 }] }, { tax_included: "NO" })).toBe(0.595);
  });

  it("adds German VAT to a price marked net that gives no rate", () => {
    expect(grossPrice({ type: "ENERGY", price: 0.42 }, { tax_included: "NO" })).toBe(0.4998);
    expect(grossPrice({ type: "ENERGY", price: 0.42, taxes: [], tax_included: false }, { tax_included: null })).toBe(0.4998);
  });

  // Values as the schema hands them over; the raw payloads are in the fetch tests.
  it("reads a rate given as a fraction as a percentage", () => {
    expect(grossPrice({ type: "ENERGY", price: 0.66386555, taxes: [{ percentage: 0.19 }], tax_included: false }, { tax_included: "NO" })).toBe(0.79);
  });

  it("adds German VAT to a net price whose rate is 0", () => {
    expect(grossPrice({ type: "ENERGY", price: 0.5798, taxes: [{ percentage: 0 }], tax_included: false }, { tax_included: "NO" })).toBe(0.69);
  });
});

describe("summarizeTariff", () => {
  it("returns gross €/kWh and the per-minute fee with its start", () => {
    expect(summarizeTariff(ENBW)).toEqual({
      energy: 0.79,
      currency: "EUR",
      fees: { perMinute: 0.24, afterMin: 30 },
    });
  });

  it("collects the session fee and skips free TIME steps", () => {
    expect(summarizeTariff(CHARGECLOUD)).toEqual({
      energy: 0.46,
      currency: "EUR",
      fees: { sessionFee: 1.5, perMinute: 0.06, afterMin: 240 },
    });
  });

  it("has no fees for an energy-only tariff", () => {
    const t: Tariff = { id: "1", source: "x", currency: "EUR", elements: [{ price_components: [{ type: "ENERGY", price: 0.41 }] }] };
    expect(summarizeTariff(t)?.fees).toEqual({});
  });

  it("keeps each restricted session fee as a rule and uses the highest", () => {
    const t: Tariff = {
      id: "1",
      source: "x",
      currency: "EUR",
      elements: [
        { price_components: [{ type: "ENERGY", price: 0.45 }] },
        { price_components: [{ type: "FLAT", price: 0.5 }], restrictions: { start_time: "06:00", end_time: "22:00" } },
        { price_components: [{ type: "FLAT", price: 1 }], restrictions: { start_time: "22:00", end_time: "06:00" } },
      ],
    };
    expect(summarizeTariff(t)?.fees).toEqual({
      sessionFee: 1,
      sessionFeeRules: [
        { fee: 0.5, from: "06:00", to: "22:00" },
        { fee: 1, from: "22:00", to: "06:00" },
      ],
    });
  });

  it("doesn't list a restricted session fee that repeats the always-on one", () => {
    // Shape of live tariff 132762 (datex2_ecomovement): elements repeated under min_duration.
    const t: Tariff = {
      id: "1",
      source: "x",
      currency: "EUR",
      elements: [
        { price_components: [{ type: "ENERGY", price: 0.5 }], restrictions: { min_duration: 14400 } },
        { price_components: [{ type: "FLAT", price: 0.5 }], restrictions: { min_duration: 14400 } },
        { price_components: [{ type: "ENERGY", price: 0.5 }] },
        { price_components: [{ type: "FLAT", price: 0.5 }] },
      ],
    };
    expect(summarizeTariff(t)?.fees).toEqual({ sessionFee: 0.5 });
  });

  it("lists an always-on session fee next to restricted ones, with weekdays and other conditions", () => {
    const t: Tariff = {
      id: "1",
      source: "x",
      currency: "EUR",
      elements: [
        { price_components: [{ type: "ENERGY", price: 0.45 }, { type: "FLAT", price: 0.3 }] },
        { price_components: [{ type: "FLAT", price: 0.8 }], restrictions: { day_of_week: ["SATURDAY", "SUNDAY"], min_kwh: 5 } },
      ],
    };
    expect(summarizeTariff(t)?.fees).toEqual({
      sessionFee: 0.8,
      sessionFeeRules: [{ fee: 0.3 }, { fee: 0.8, days: [6, 7], other: true }],
    });
  });

  it("is null without a per-kWh price", () => {
    const t: Tariff = { id: "1", source: "x", currency: "EUR", elements: [{ price_components: [{ type: "FLAT", price: 5 }] }] };
    expect(summarizeTariff(t)).toBeNull();
  });
});

describe("evseTariffs", () => {
  it("keeps the cheapest ad-hoc tariff per EVSE and ignores other audiences", () => {
    const byEvse = evseTariffs(
      [ENBW, CHARGECLOUD],
      [
        { tariff_id: ENBW.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "a" }, { evse_uid: "b" }] },
        { tariff_id: CHARGECLOUD.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "b" }] },
        { tariff_id: CHARGECLOUD.id, audience: "REGULAR_PAYMENT", evses: [{ evse_uid: "a" }] },
      ],
    );
    expect(byEvse.get("a")?.energy).toBe(0.79);
    expect(byEvse.get("b")?.energy).toBe(0.46);
  });

  const energyOnly = (id: string, price: number, flat?: number): Tariff => ({
    id,
    source: "x",
    currency: "EUR",
    elements: [
      {
        price_components: [
          { type: "ENERGY", price },
          ...(flat != null ? [{ type: "FLAT", price: flat }] : []),
        ],
      },
    ],
  });

  it("ignores associations with no audience", () => {
    const byEvse = evseTariffs(
      [energyOnly("contract", 0.29), energyOnly("adhoc", 0.59)],
      [
        { tariff_id: "contract", audience: null, evses: [{ evse_uid: "a" }] },
        { tariff_id: "adhoc", audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "a" }] },
      ],
    );
    expect(byEvse.get("a")?.energy).toBe(0.59);
  });

  it("skips an implausible tariff so it can't hide a valid one", () => {
    const byEvse = evseTariffs(
      [energyOnly("free", 0), energyOnly("promo", 0.05), energyOnly("normal", 0.49)],
      ["free", "promo", "normal"].map((id) => ({ tariff_id: id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "a" }] })),
    );
    expect(byEvse.get("a")?.energy).toBe(0.49);
  });

  it("ranks by €/kWh with the session fee spread over a session", () => {
    const byEvse = evseTariffs(
      [energyOnly("cheap-rate", 0.39, 10), energyOnly("no-fee", 0.45)],
      ["cheap-rate", "no-fee"].map((id) => ({ tariff_id: id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "a" }] })),
    );
    expect(byEvse.get("a")?.energy).toBe(0.45);
    expect(effectivePerKwh({ energy: 0.39, currency: "EUR", fees: { sessionFee: 10 } })).toBeCloseTo(0.39 + 10 / 30);
  });

  it("stamps each tariff with its feed's refresh time", () => {
    const refreshed = new Date("2026-10-20T04:00:00Z");
    const byEvse = evseTariffs(
      [ENBW],
      [{ tariff_id: ENBW.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "a" }] }],
      new Map([["datex2_enbw", refreshed]]),
    );
    expect(byEvse.get("a")?.reportedAt).toEqual(refreshed);
  });
});

describe("liveSources", () => {
  const now = new Date("2026-10-22T12:00:00Z");

  it("keeps active feeds refreshed within the window", () => {
    const live = liveSources(
      [
        { uid: "fresh", static_status: "ACTIVE", static_data_updated_at: "2026-10-22T04:00:00Z" },
        { uid: "old", static_status: "ACTIVE", static_data_updated_at: "2026-09-07T04:00:00Z" },
        { uid: "failed", static_status: "FAILED", static_data_updated_at: "2026-10-22T04:00:00Z" },
        { uid: "never", static_status: "ACTIVE", static_data_updated_at: null },
      ],
      now,
      3,
    );
    expect([...live]).toEqual([["fresh", new Date("2026-10-22T04:00:00Z")]]);
  });

  it("drops a dead feed's tariffs from the EVSE map", () => {
    const byEvse = evseTariffs(
      [ENBW, CHARGECLOUD],
      [
        { tariff_id: ENBW.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "a" }] },
        { tariff_id: CHARGECLOUD.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "a" }, { evse_uid: "b" }] },
      ],
      new Map([["datex2_enbw", new Date()]]),
    );
    expect(byEvse.get("a")?.energy).toBe(0.79);
    expect(byEvse.has("b")).toBe(false);
  });
});

describe("mergeLocations", () => {
  const tariffs = evseTariffs(
    [ENBW, CHARGECLOUD],
    [
      { tariff_id: ENBW.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "enbw" }] },
      { tariff_id: CHARGECLOUD.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "cc" }] },
    ],
  );

  it("builds a priced charger pin", () => {
    const { stations, prices } = mergeLocations([location({ evses: ["enbw"] })], tariffs);
    expect(stations).toEqual([
      expect.objectContaining({
        externalId: stationKey(48.7758, 9.1829),
        brand: "EnBW mobility+ AG und Co.KG",
        address: "Königstraße 1, 70173",
        city: "Stuttgart",
        province: "Baden-Württemberg",
        stationType: "ev_charger",
        maxPowerKw: 22,
      }),
    ]);
    expect(prices).toEqual([
      {
        stationExternalId: stationKey(48.7758, 9.1829),
        fuelType: "EV",
        price: 0.79,
        currency: "EUR",
        evFees: { perMinute: 0.24, afterMin: 30 },
      },
    ]);
  });

  it("folds a feed's duplicate into the register pin, keeping register coordinates and the feed's price", () => {
    const { stations, prices, stats } = mergeLocations(
      [
        // Feed first upstream: the register must still anchor the pin.
        location({ source: "datex2_chargecloud", lat: 48.7758 + 10 * METRES, evses: ["cc"] }),
        location({ evses: ["unpriced"] }),
      ],
      tariffs,
    );
    expect(stats.merged).toBe(1);
    expect(stations).toHaveLength(1);
    expect(stations[0].latitude).toBe(48.7758);
    expect(prices[0]).toMatchObject({ stationExternalId: stations[0].externalId, price: 0.46 });
  });

  /** A location whose EVSEs (uid → kW) are given explicitly. */
  function site(evses: Record<string, number>, overrides: Parameters<typeof location>[0] = {}): Location {
    const loc = location({ evses: Object.keys(evses), ...overrides });
    loc.charging_pool[0].evses.forEach((e) => (e.connectors = [{ max_electric_power: evses[e.uid] * 1000 }]));
    return loc;
  }

  // Like ocpdb-51.14720_7.32149 (EnBW Hückeswagen): DC at 0.79, AC at 0.70.
  // The pin shows 150 kW, so it must show the 150 kW price.
  const hpc = evseTariffs(
    [ENBW, { ...ENBW, id: "ac", elements: [{ price_components: [{ type: "ENERGY", price: 0.7, tax_included: true }] }] }],
    [
      { tariff_id: ENBW.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "dc" }] },
      { tariff_id: "ac", audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "ac" }] },
    ],
  );

  it("prices a pin from the EVSEs at its top power, not the cheapest slower one", () => {
    const { stations, prices } = mergeLocations([site({ dc: 150, ac: 22 })], hpc);
    expect(stations[0].maxPowerKw).toBe(150);
    expect(prices[0]).toMatchObject({ price: 0.79, evFees: { perMinute: 0.24, afterMin: 30 } });
  });

  it("falls back to the cheapest EVSE when none at the top power is priced", () => {
    const { stations, prices } = mergeLocations([site({ unpriced: 150, ac: 22 })], hpc);
    expect(stations[0].maxPowerKw).toBe(150);
    expect(prices[0].price).toBe(0.7);
  });

  it("applies the same rule across merged locations", () => {
    const { stations, prices } = mergeLocations(
      [
        site({ ac: 22 }),
        site({ dc: 150 }, { source: "datex2_enbw", lon: 9.1829 + 5 * METRES, operator: { name: "EnBW AG" } }),
      ],
      hpc,
    );
    expect(stations[0].maxPowerKw).toBe(150);
    expect(prices[0].price).toBe(0.79);
    expect(stations[0].brand).toBe("EnBW AG");
  });

  it("keeps the cheapest price across merged locations of the same power", () => {
    const { prices } = mergeLocations(
      [
        location({ source: "datex2_enbw", evses: ["enbw"] }),
        location({ source: "datex2_chargecloud", lon: 9.1829 + 5 * METRES, evses: ["cc"] }),
      ],
      tariffs,
    );
    expect(prices).toHaveLength(1);
    expect(prices[0].price).toBe(0.46);
  });

  it("labels a merged pin with the operator whose price it shows", () => {
    const { stations, prices } = mergeLocations(
      [
        location({ source: "datex2_enbw", name: "Marktplatz", evses: ["enbw"] }),
        location({
          source: "datex2_chargecloud",
          lon: 9.1829 + 5 * METRES,
          operator: { name: "Wirelane GmbH" },
          evses: ["cc"],
        }),
      ],
      tariffs,
    );
    expect(prices[0].price).toBe(0.46);
    expect(stations[0]).toMatchObject({ brand: "Wirelane GmbH", name: "Wirelane GmbH — Marktplatz" });
  });

  it("keeps the anchor's operator when the anchor's own price wins", () => {
    const { stations, prices } = mergeLocations(
      [
        location({ source: "datex2_chargecloud", evses: ["cc"] }),
        location({ source: "datex2_wirelane", lon: 9.1829 + 5 * METRES, operator: { name: "Wirelane GmbH" }, evses: ["enbw"] }),
      ],
      tariffs,
    );
    expect(prices[0].price).toBe(0.46);
    expect(stations[0].brand).toBe("EnBW mobility+ AG und Co.KG");
  });

  it("carries the tariff's refresh time onto the price row", () => {
    const refreshed = new Date("2026-10-20T04:00:00Z");
    const stamped = evseTariffs(
      [ENBW],
      [{ tariff_id: ENBW.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "enbw" }] }],
      new Map([["datex2_enbw", refreshed]]),
    );
    const { prices } = mergeLocations([location({ evses: ["enbw"] })], stamped);
    expect(prices[0].reportedAt).toEqual(refreshed);
  });

  it("keeps register sites a few metres apart separate", () => {
    const { stations, stats } = mergeLocations(
      [location(), location({ lat: 48.7758 + 10 * METRES, operator: { name: "Stadtwerke Stuttgart" } })],
      tariffs,
    );
    expect(stats.merged).toBe(0);
    expect(stations.map((s) => s.brand)).toEqual(["EnBW mobility+ AG und Co.KG", "Stadtwerke Stuttgart"]);
  });

  it("merges register rows that share a site at 5 dp", () => {
    const { stations, stats } = mergeLocations([location(), location({ lat: 48.775801 })], tariffs);
    expect(stats.merged).toBe(1);
    expect(stations).toHaveLength(1);
  });

  it("keeps locations further apart than the merge radius separate", () => {
    const { stations } = mergeLocations([location(), location({ lat: 48.7758 + 40 * METRES })], tariffs);
    expect(stations).toHaveLength(2);
  });

  it("drops locations outside Germany and those with only removed or planned EVSEs", () => {
    const dead = location({ lat: 50 });
    dead.charging_pool[0].evses.forEach((e, i) => (e.status = i % 2 ? "PLANNED" : "REMOVED"));
    const { stations, stats } = mergeLocations(
      [location({ country: "CHE" }), location({ lat: 40 }), dead],
      tariffs,
    );
    expect(stations).toEqual([]);
    expect(stats.notGermany).toBe(2);
    expect(stats.noLiveEvse).toBe(1);
  });

  it("leaves an unpriced pin without a price row", () => {
    const { stations, prices } = mergeLocations([location({ evses: ["nothing"] })], tariffs);
    expect(stations).toHaveLength(1);
    expect(prices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetch(): paging, feed health and bad records, with the network stubbed.
// ---------------------------------------------------------------------------
describe("OcpdbScraper.fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  const page = (items: unknown[], total = items.length) => json({ items, total_count: total });

  /** Routes each URL to a page; records every URL requested. */
  function stubApi(
    opts: { sources?: unknown[]; tariffs?: unknown[]; locationsTotal?: number; failOnce?: string; failAlways?: string } = {},
  ) {
    const urls: string[] = [];
    const failed = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        urls.push(url);
        if (opts.failAlways && url.includes(opts.failAlways)) {
          return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
        }
        if (opts.failOnce && url.includes(opts.failOnce) && !failed.has(url)) {
          failed.add(url);
          throw new Error("socket hang up");
        }
        if (url.endsWith("/public/v1/sources")) {
          return json({
            items: opts.sources ?? [
              { uid: "datex2_enbw", static_status: "ACTIVE", static_data_updated_at: new Date().toISOString() },
              { uid: "datex2_chargecloud", static_status: "ACTIVE", static_data_updated_at: new Date().toISOString() },
            ],
          });
        }
        if (url.includes("/tariffs?")) return page(opts.tariffs ?? [ENBW, CHARGECLOUD]);
        if (url.includes("/tariff-associations?")) {
          return page([
            { tariff_id: ENBW.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "enbw" }] },
            { tariff_id: CHARGECLOUD.id, audience: "AD_HOC_PAYMENT", evses: [{ evse_uid: "cc" }] },
          ]);
        }
        const offset = Number(new URL(url).searchParams.get("offset"));
        // One location per page, a degree of latitude apart so none merge.
        // The first page also carries one record the schema rejects.
        const items: unknown[] = [location({ lat: 48 + offset / 1000, evses: [offset === 0 ? "enbw" : "cc"] })];
        if (offset === 0) items.push({ source: "broken" });
        return page(items, opts.locationsTotal ?? 1);
      }),
    );
    return urls;
  }

  it("reads every page of locations in steps of 1000", async () => {
    const urls = stubApi({ locationsTotal: 2500 });
    const { OcpdbScraper } = await import("./ocpdb");

    const { stations } = await new OcpdbScraper().fetch();

    const offsets = urls.filter((u) => u.includes("/locations?")).map((u) => new URL(u).searchParams.get("offset"));
    expect(offsets.sort()).toEqual(["0", "1000", "2000"]);
    expect(urls.filter((u) => u.includes("/locations?")).every((u) => u.includes("country=DEU&limit=1000"))).toBe(true);
    expect(stations).toHaveLength(3);
  });

  it("skips records that fail to parse instead of failing the run", async () => {
    stubApi();
    const { OcpdbScraper } = await import("./ocpdb");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { stations, prices } = await new OcpdbScraper().fetch();

    expect(stations).toHaveLength(1);
    expect(prices).toEqual([expect.objectContaining({ fuelType: "EV", price: 0.79 })]);
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toMatch(/1 unparseable/);
  });

  // TotalEnergies tariffs on EcoMovement (132622, 132721, 132724, 133685) give
  // the rate as a fraction; 132725 gives a net price with a rate of "0". Both
  // are 0.79 / 0.69 gross. The ids stand in for the stub's associations.
  it("prices the live VAT shapes gross", async () => {
    const net = (price: number, percentage: string) => ({
      type: "ENERGY",
      price,
      taxes: [{ percentage }],
      tax_included: false,
      step_size: 1,
    });
    stubApi({
      locationsTotal: 1001,
      tariffs: [
        { id: ENBW.id, source: "datex2_enbw", currency: "EUR", tax_included: "NO", elements: [{ price_components: [net(0.66386555, "0.19000000000000000000")] }] },
        { id: CHARGECLOUD.id, source: "datex2_chargecloud", currency: "EUR", tax_included: "NO", elements: [{ price_components: [net(0.5798, "0")] }] },
      ],
    });
    const { OcpdbScraper } = await import("./ocpdb");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { prices } = await new OcpdbScraper().fetch();

    expect(prices.map((p) => p.price).sort()).toEqual([0.69, 0.79]);
  });

  it("leaves a dead feed's chargers on the map without a price", async () => {
    stubApi({
      locationsTotal: 2,
      sources: [
        { uid: "datex2_enbw", static_status: "FAILED", static_data_updated_at: new Date().toISOString() },
        { uid: "datex2_chargecloud", static_status: "ACTIVE", static_data_updated_at: new Date().toISOString() },
      ],
    });
    const { OcpdbScraper } = await import("./ocpdb");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { stations, prices } = await new OcpdbScraper().fetch();

    expect(stations).toHaveLength(1); // offset 0 only: total 2 fits one page
    expect(prices).toEqual([]); // that pin's EVSE is priced only by EnBW
    expect(warn.mock.calls.flat().join(" ")).toMatch(/datex2_enbw/);
  });

  it("fails the run when feed health is unavailable, so the current prices stay", async () => {
    const urls = stubApi({ failAlways: "/public/v1/sources" });
    const { OcpdbScraper } = await import("./ocpdb");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(new OcpdbScraper().fetch()).rejects.toThrow(/for sources/);
    expect(urls.filter((u) => u.includes("/public/v1/sources"))).toHaveLength(2); // one retry
  });

  it("retries feed health once", async () => {
    stubApi({ failOnce: "/public/v1/sources" });
    const { OcpdbScraper } = await import("./ocpdb");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { stations } = await new OcpdbScraper().fetch();
    expect(stations).toHaveLength(1);
  });

  it("retries a page once", async () => {
    const urls = stubApi({ failOnce: "/tariffs?" });
    const { OcpdbScraper } = await import("./ocpdb");

    await expect(new OcpdbScraper().fetch()).resolves.toBeDefined();
    expect(urls.filter((u) => u.includes("/tariffs?"))).toHaveLength(2);
  });

  it("fails the fetch when a page keeps failing, rather than writing a partial map", async () => {
    stubApi({ failAlways: "/locations?" });
    const { OcpdbScraper } = await import("./ocpdb");

    await expect(new OcpdbScraper().fetch()).rejects.toThrow(/503/);
  });
});

// ---------------------------------------------------------------------------
// The cleanup sweep, the only destructive thing this scraper does. base.run()
// is stubbed out so these exercise the gating and the SQL alone.
// ---------------------------------------------------------------------------
describe("OcpdbScraper cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  async function setup(opts: { results?: Array<Array<{ count: bigint }>>; errors?: string[] } = {}) {
    const results = [...(opts.results ?? [])];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
        queries.push({ sql, params });
        return results.shift() ?? [];
      }),
      $disconnect: vi.fn(async () => {}),
    };
    const { PrismaClient } = await import("../generated/prisma/client");
    const { BaseScraper } = await import("./base");
    // A plain function, not an arrow: this stands in for a constructor.
    vi.mocked(PrismaClient).mockImplementation(function () {
      return client;
    } as never);
    vi.spyOn(BaseScraper.prototype, "run").mockResolvedValue({
      country: "DE",
      source: "ocpdb",
      stationsUpserted: 69160,
      pricesUpserted: 25500,
      durationMs: 60_000,
      errors: opts.errors ?? [],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { OcpdbScraper } = await import("./ocpdb");
    return { queries, client, scraper: new OcpdbScraper() };
  }

  it("prunes stale OCPDB rows and retires BNetzA and OpenChargeMap once the floor is cleared", async () => {
    const { queries, scraper } = await setup({
      results: [[{ count: BigInt(69160) }], [{ count: BigInt(7) }], [{ count: BigInt(74223) }]],
    });

    const result = await scraper.run();

    expect(result.errors).toEqual([]);
    expect(queries).toHaveLength(3);

    // The floor counts only rows this run refreshed.
    expect(queries[0].sql).toMatch(/count\(\*\)/);
    expect(queries[0].sql).not.toMatch(/DELETE/);
    expect(queries[0].sql).toMatch(/updated_at >= NOW\(\) - make_interval/);
    expect(queries[0].params).toEqual([60 + 300, "DE", "ocpdb-%"]);

    // Stale sweep: this source only, cut off by run duration + margin.
    expect(queries[1].sql).toMatch(/DELETE FROM stations/);
    expect(queries[1].sql).toMatch(/updated_at < NOW\(\) - make_interval/);
    expect(queries[1].params).toEqual([60 + 300, "DE", "ocpdb-%"]);

    // Retirement: German chargers only, from the two sources OCPDB replaces.
    expect(queries[2].sql).toMatch(/DELETE FROM stations/);
    expect(queries[2].sql).toMatch(/station_type = 'ev_charger'/);
    expect(queries[2].params).toEqual(["DE", ["ocm-%", "bnetza-%"]]);
  });

  it("deletes nothing when too few stations were refreshed", async () => {
    const { queries, scraper } = await setup({ results: [[{ count: BigInt(42) }]] });

    await scraper.run();

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).not.toMatch(/DELETE/);
  });

  it("does not sweep after a failed pipeline run", async () => {
    const { queries, scraper } = await setup({ errors: ["upsert failed"] });

    const result = await scraper.run();

    expect(queries).toEqual([]);
    expect(result.errors).toEqual(["upsert failed"]);
  });

  it("reports a failed sweep as an error and still disconnects", async () => {
    const { client, scraper } = await setup();
    client.$queryRawUnsafe.mockRejectedValueOnce(new Error("connection reset"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await scraper.run();

    expect(result.errors).toEqual(["Cleanup: connection reset"]);
    expect(client.$disconnect).toHaveBeenCalled();
  });

  it("honours PUMPERLY_OCPDB_MIN_STATIONS", async () => {
    vi.stubEnv("PUMPERLY_OCPDB_MIN_STATIONS", "40");
    const { queries, scraper } = await setup({ results: [[{ count: BigInt(42) }]] });

    await scraper.run();

    expect(queries).toHaveLength(3); // 42 now clears the lowered floor
  });

  it("ignores a nonsensical floor rather than disabling the guard", async () => {
    vi.stubEnv("PUMPERLY_OCPDB_MIN_STATIONS", "not-a-number");
    const { queries, scraper } = await setup({ results: [[{ count: BigInt(42) }]] });

    await scraper.run();

    expect(queries).toHaveLength(1);
  });
});
