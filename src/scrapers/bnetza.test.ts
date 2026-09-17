import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../generated/prisma/client", () => ({ PrismaClient: vi.fn() }));

// The register's 26 columns, in file order.
const HEADER = [
  "Betreiber",
  "Adresszusatz",
  "Straße",
  "Hausnummer",
  "Postleitzahl",
  "Ort",
  "Breitengrad",
  "Längengrad",
  "Inbetriebnahmedatum",
  "Nennleistung Ladeeinrichtung [kW]",
  "Art der Ladeeinrichtung",
  "Anzahl Ladepunkte",
  "Steckertypen1",
  "Nennleistung Stecker1",
  "Steckertypen2",
  "Nennleistung Stecker2",
  "Steckertypen3",
  "Nennleistung Stecker3",
  "Steckertypen4",
  "Nennleistung Stecker4",
  "Zugangsbeschränkung",
  "Öffnungszeiten",
  "Debitkarte",
  "Kreditkarte",
  "Bargeld",
  "Status",
] as const;

type Field = (typeof HEADER)[number];

// One row shaped exactly like a real register entry (the Berliner Stadtwerke
// charger on Leipziger Platz), overridable per test.
function row(overrides: Partial<Record<Field, string>> = {}): string {
  const base: Record<string, string> = {
    Betreiber: "Berliner Stadtwerke KommunalPartner GmbH",
    Adresszusatz: "",
    "Straße": "Leipziger Platz",
    Hausnummer: "19",
    Postleitzahl: "01011",
    Ort: "Berlin",
    Breitengrad: "52.510055",
    "Längengrad": "13.377592",
    Inbetriebnahmedatum: "30.06.2023",
    "Nennleistung Ladeeinrichtung [kW]": "30.0",
    "Art der Ladeeinrichtung": "0",
    "Anzahl Ladepunkte": "2",
    Steckertypen1: "AC Typ 2 Steckdose",
    "Nennleistung Stecker1": "22",
    Steckertypen2: "AC Typ 2 Steckdose",
    "Nennleistung Stecker2": "22",
    Steckertypen3: "",
    "Nennleistung Stecker3": "",
    Steckertypen4: "",
    "Nennleistung Stecker4": "",
    "Zugangsbeschränkung": "",
    "Öffnungszeiten": "247",
    Debitkarte: "",
    Kreditkarte: "",
    Bargeld: "",
    Status: "1",
    ...overrides,
  };
  return HEADER.map((h) => base[h]).join("\t");
}

function tsv(...rows: string[]): string {
  return [HEADER.join("\t"), ...rows].join("\n");
}

describe("parseBnetzaTsv", () => {
  it("maps an operational row into an EV charger station", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations, stats } = parseBnetzaTsv(tsv(row()));

    expect(stations).toHaveLength(1);
    expect(stations[0]).toEqual({
      externalId: "bnetza-52.51006_13.37759",
      name: "Berliner Stadtwerke KommunalPartner GmbH — Leipziger Platz 19",
      brand: "Berliner Stadtwerke KommunalPartner GmbH",
      address: "Leipziger Platz 19, 01011",
      city: "Berlin",
      province: null,
      latitude: 52.510055,
      longitude: 13.377592,
      stationType: "ev_charger",
    });
    expect(stats).toEqual({
      totalRows: 1,
      malformed: 0,
      notOperational: 0,
      outOfBbox: 0,
      mergedDuplicates: 0,
      operatorConflicts: 0,
    });
  });

  it("carries both Adresszusatz and the street in the search name", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations } = parseBnetzaTsv(
      tsv(row({ Betreiber: "Q-Park Recharge Germany GmbH", Adresszusatz: "Tiefgarage" })),
    );
    // "Tiefgarage" alone appears on hundreds of rows and disambiguates nothing;
    // the street is what tells one Q-Park garage from the next.
    expect(stations[0].name).toBe("Q-Park Recharge Germany GmbH — Tiefgarage, Leipziger Platz 19");
    expect(stations[0].address).toBe("Leipziger Platz 19, 01011");
  });

  it("merges the per-Ladeeinrichtung rows of one site into a single station", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    // The real Q-Park garage at Landhausstraße 2, Dresden: five identical rows.
    const site = {
      Betreiber: "Q-Park Recharge Germany GmbH",
      "Straße": "Landhausstraße",
      Hausnummer: "2",
      Breitengrad: "51.050944",
      "Längengrad": "13.74154",
    };
    const { stations, stats } = parseBnetzaTsv(
      tsv(row(site), row(site), row(site), row(site), row(site)),
    );

    expect(stations).toHaveLength(1);
    expect(stats.totalRows).toBe(5);
    expect(stats.mergedDuplicates).toBe(4);
    expect(stations[0].externalId).toBe("bnetza-51.05094_13.74154");
  });

  it("merges within ~1m but keeps distinct chargers apart", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const at = (lat: string) => row({ Breitengrad: lat, "Längengrad": "13.74154" });

    // Sub-metre apart: the same physical site published at two precisions.
    expect(parseBnetzaTsv(tsv(at("51.0500014"), at("51.0500042"))).stations).toHaveLength(1);
    // ~11m apart: genuinely different chargers, which 4 decimals would fold.
    expect(parseBnetzaTsv(tsv(at("51.0501"), at("51.0502"))).stations).toHaveLength(2);
  });

  it("gives one station one id when coordinates repeat under different street spellings", async () => {
    // The regression guard for the batch-upsert collision: 1,136 coordinate
    // pairs in the real file carry two street spellings, so an externalId
    // derived on anything coarser than the merge key mints duplicate ids and
    // Postgres rejects the whole 500-row batch with 21000.
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations } = parseBnetzaTsv(
      tsv(
        row({ "Straße": "Landhausstr.", Breitengrad: "51.050944", "Längengrad": "13.74154" }),
        row({ "Straße": "Landhausstraße", Breitengrad: "51.050944", "Längengrad": "13.74154" }),
      ),
    );
    expect(stations).toHaveLength(1);
    expect(stations[0].address).toBe("Landhausstr. 19, 01011"); // first row wins
  });

  it("emits no duplicate externalIds", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations } = parseBnetzaTsv(
      tsv(
        row(),
        row(),
        row({ "Straße": "Anderer Weg" }),
        row({ Breitengrad: "51.438147", "Längengrad": "14.244672" }),
        row({ Breitengrad: "51.438147", "Längengrad": "14.244672", Betreiber: "Andere GmbH" }),
      ),
    );
    const ids = stations.map((s) => s.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("counts an operator disagreement when merging, as a signal the key over-merges", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations, stats } = parseBnetzaTsv(
      tsv(row({ Betreiber: "EnBW mobility+ AG und Co.KG" }), row({ Betreiber: "E.ON Drive GmbH" })),
    );
    expect(stations).toHaveLength(1);
    expect(stats.mergedDuplicates).toBe(1);
    expect(stats.operatorConflicts).toBe(1);
  });

  it("drops non-operational rows without calling them malformed", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations, stats } = parseBnetzaTsv(tsv(row({ Status: "0" }), row()));

    expect(stations).toHaveLength(1);
    expect(stats.notOperational).toBe(1);
    expect(stats.malformed).toBe(0);
  });

  it("drops coordinates outside Germany", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    // The real bad row: a Lemgo charger published at longitude 4.
    const { stations, stats } = parseBnetzaTsv(
      tsv(
        row({
          Betreiber: "Wirelane GmbH",
          "Straße": "Lagesche Straße",
          Hausnummer: "32",
          Ort: "Lemgo",
          Breitengrad: "52.023038",
          "Längengrad": "4",
        }),
        row(),
      ),
    );

    expect(stations).toHaveLength(1);
    expect(stats.outOfBbox).toBe(1);
    expect(stats.malformed).toBe(0);
  });

  it("drops malformed rows and keeps their neighbours", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const shortRow = HEADER.slice(1)
      .map(() => "x")
      .join("\t"); // 25 fields
    const { stations, stats } = parseBnetzaTsv(
      tsv(row(), shortRow, row({ Breitengrad: "n/a", "Längengrad": "13.0" }), row({ Ort: "Köln" })),
    );

    expect(stats.malformed).toBe(2);
    expect(stations).toHaveLength(1); // rows 1 and 4 share coordinates → merged
    expect(stations[0].city).toBe("Berlin");
  });

  it("rejects a blank coordinate rather than placing it at Null Island", async () => {
    // z.coerce.number() would turn "" into 0 and put this charger in the
    // Atlantic; the schema's regex rejects it outright.
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations, stats } = parseBnetzaTsv(
      tsv(row({ Breitengrad: "", "Längengrad": "" }), row({ Breitengrad: "52,5", "Längengrad": "13,3" })),
    );

    expect(stations).toEqual([]);
    expect(stats.malformed).toBe(2);
  });

  it("unquotes RFC4180 fields", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations } = parseBnetzaTsv(
      tsv(
        row({
          Betreiber: '"Hotel ""Zur Mühle"" GmbH"',
          Adresszusatz: '"Parkplatz ""Am Neumarkt am Wehr"""',
        }),
      ),
    );

    expect(stations[0].brand).toBe('Hotel "Zur Mühle" GmbH');
    expect(stations[0].name).toBe(
      'Hotel "Zur Mühle" GmbH — Parkplatz "Am Neumarkt am Wehr", Leipziger Platz 19',
    );
  });

  it("skips blank and trailing lines without counting them", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations, stats } = parseBnetzaTsv(`${tsv(row())}\n\n   \n`);

    expect(stations).toHaveLength(1);
    expect(stats.totalRows).toBe(1);
    expect(stats.malformed).toBe(0);
  });

  it("never emits the header as a station", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const { stations, stats } = parseBnetzaTsv(tsv());

    expect(stations).toEqual([]);
    expect(stats.totalRows).toBe(0);
  });

  it("throws, naming the column, when the header changes shape", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const renamed = tsv(row()).replace("Breitengrad", "Latitude");

    // Throwing is the point: base.run() catches it and does nothing
    // destructive, so a format change costs a cycle rather than the table.
    expect(() => parseBnetzaTsv(renamed)).toThrow(/Breitengrad/);
  });

  it("parses CRLF input identically to LF", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    const lf = tsv(row());
    const crlf = lf.replace(/\n/g, "\r\n");

    // Without \r handling the trailing Status column becomes "1\r" and every
    // row would silently look non-operational.
    expect(parseBnetzaTsv(crlf).stations).toEqual(parseBnetzaTsv(lf).stations);
    expect(parseBnetzaTsv(crlf).stations).toHaveLength(1);
  });

  it("tolerates a UTF-8 BOM on the header", async () => {
    const { parseBnetzaTsv } = await import("./bnetza");
    expect(parseBnetzaTsv(`﻿${tsv(row())}`).stations).toHaveLength(1);
  });
});

describe("stationKey", () => {
  it("is the externalId, so both round identically", async () => {
    const { stationKey, parseBnetzaTsv } = await import("./bnetza");
    const { stations } = parseBnetzaTsv(tsv(row()));
    expect(stations[0].externalId).toBe(stationKey(52.510055, 13.377592));
  });

  it("is URL-safe, since externalIds go into share links", async () => {
    const { stationKey } = await import("./bnetza");
    const key = stationKey(52.510055, 13.377592);
    expect(encodeURIComponent(key)).toBe(key);
  });
});

describe("unquote", () => {
  it("leaves ordinary values alone and collapses doubled quotes", async () => {
    const { unquote } = await import("./bnetza");
    expect(unquote("EnBW mobility+ AG und Co.KG")).toBe("EnBW mobility+ AG und Co.KG");
    expect(unquote("  padded  ")).toBe("padded");
    expect(unquote('""')).toBe("");
    expect(unquote('"')).toBe('"'); // too short to be a quoted field
    expect(unquote('"Parkplatz ""Am Neumarkt am Wehr"""')).toBe('Parkplatz "Am Neumarkt am Wehr"');
  });
});

describe("BNetzAScraper", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  function okResponse(body: string) {
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  }

  it("has correct source and country", async () => {
    const { BNetzAScraper } = await import("./bnetza");
    const scraper = new BNetzAScraper();
    expect(scraper.country).toBe("DE");
    expect(scraper.source).toBe("bnetza");
  });

  it("returns stations and never invents a price", async () => {
    const { BNetzAScraper } = await import("./bnetza");
    vi.mocked(fetch).mockResolvedValue(okResponse(tsv(row(), row({ Ort: "Köln" }))));

    const { stations, prices } = await new BNetzAScraper().fetch();

    expect(prices).toEqual([]);
    expect(stations).toHaveLength(1);
    expect(stations[0].stationType).toBe("ev_charger");
  });

  it("identifies itself and bounds the download", async () => {
    const { BNetzAScraper } = await import("./bnetza");
    vi.mocked(fetch).mockResolvedValue(okResponse(tsv(row())));

    await new BNetzAScraper().fetch();

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://lade.info/data/stationen_XXXX.txt");
    const opts = init as RequestInit & { headers: Record<string, string> };
    expect(opts.headers["User-Agent"]).toMatch(/^Pumperly\//);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws on a non-OK response rather than wiping data", async () => {
    const { BNetzAScraper } = await import("./bnetza");
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "upstream down",
    } as unknown as Response);

    await expect(new BNetzAScraper().fetch()).rejects.toThrow(/503/);
  });
});

// ---------------------------------------------------------------------------
// The cleanup sweeps, which are the only destructive thing this scraper does.
// base.run() is stubbed out so these exercise the gating and the SQL alone.
// ---------------------------------------------------------------------------
describe("BNetzAScraper cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  /** A PrismaClient stand-in that records every statement it is handed. */
  function stubPrisma(results: Array<Array<{ count: bigint }>>) {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
        queries.push({ sql, params });
        return results.shift() ?? [];
      }),
      $disconnect: vi.fn(async () => {}),
    };
    return { queries, client };
  }

  async function setup(opts: {
    results?: Array<Array<{ count: bigint }>>;
    client?: ReturnType<typeof stubPrisma>;
    errors?: string[];
    durationMs?: number;
  }) {
    const { PrismaClient } = await import("../generated/prisma/client");
    const { BaseScraper } = await import("./base");
    const stub = opts.client ?? stubPrisma(opts.results ?? []);
    // A plain function, not an arrow: this stands in for a constructor.
    vi.mocked(PrismaClient).mockImplementation(function () {
      return stub.client;
    } as never);
    vi.spyOn(BaseScraper.prototype, "run").mockResolvedValue({
      country: "DE",
      source: "bnetza",
      stationsUpserted: 74223,
      pricesUpserted: 0,
      durationMs: opts.durationMs ?? 30_000,
      errors: opts.errors ?? [],
    });
    return stub;
  }

  it("prunes stale rows and retires OpenChargeMap once the floor is cleared", async () => {
    const stub = await setup({
      results: [[{ count: BigInt(74223) }], [{ count: BigInt(12) }], [{ count: BigInt(19067) }]],
    });
    const { BNetzAScraper } = await import("./bnetza");

    const result = await new BNetzAScraper().run();

    expect(result.errors).toEqual([]);
    expect(stub.queries).toHaveLength(3);

    // The floor counts only rows this run refreshed, using the same cutoff as
    // the stale sweep, so rows left over from an earlier run cannot clear it.
    expect(stub.queries[0].sql).toMatch(/count\(\*\)/);
    expect(stub.queries[0].sql).toMatch(/external_id LIKE 'bnetza-%'/);
    expect(stub.queries[0].sql).toMatch(/updated_at >= NOW\(\) - make_interval/);
    expect(stub.queries[0].params[0]).toBe(30 + 300);

    // Stale sweep: scoped to this source, and cut off by a duration measured
    // back from the DB clock so app/DB clock skew cannot delete fresh rows.
    expect(stub.queries[1].sql).toMatch(/DELETE FROM stations/);
    expect(stub.queries[1].sql).toMatch(/external_id LIKE 'bnetza-%'/);
    expect(stub.queries[1].sql).toMatch(/updated_at < NOW\(\) - make_interval/);
    expect(stub.queries[1].params[0]).toBe(30 + 300); // run duration + margin

    // Retirement: OpenChargeMap's German chargers, which nothing else removes.
    expect(stub.queries[2].sql).toMatch(/external_id LIKE 'ocm-%'/);
    expect(stub.queries[2].sql).toMatch(/station_type = 'ev_charger'/);
  });

  it("leaves yesterday's rows alone when a degraded fetch refreshed too few of them", async () => {
    // 74,000 rows from yesterday's run plus 42 from today's degraded fetch.
    // Counting them together would clear the floor and delete the 74,000.
    const rowAgesSeconds = [...Array<number>(74_000).fill(86_400), ...Array<number>(42).fill(5)];
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
        queries.push({ sql, params });
        if (/DELETE/.test(sql)) throw new Error("sweep ran against a degraded fetch");
        // Answer the count the way Postgres would: apply the freshness window
        // if the statement has one, otherwise count every row.
        const window = /updated_at >= NOW\(\) - make_interval/.test(sql)
          ? Number(params[0])
          : Infinity;
        return [{ count: BigInt(rowAgesSeconds.filter((age) => age <= window).length) }];
      }),
      $disconnect: vi.fn(async () => {}),
    };
    await setup({ client: { queries, client } });
    const { BNetzAScraper } = await import("./bnetza");

    const result = await new BNetzAScraper().run();

    expect(result.errors).toEqual([]);
    expect(queries).toHaveLength(1);
  });

  it("deletes nothing when too few stations were refreshed", async () => {
    // A degraded fetch that still clears base.run()'s empty-fetch guard must
    // not be able to wipe yesterday's map.
    const stub = await setup({ results: [[{ count: BigInt(42) }]] });
    const { BNetzAScraper } = await import("./bnetza");

    await new BNetzAScraper().run();

    expect(stub.queries).toHaveLength(1);
    expect(stub.queries[0].sql).not.toMatch(/DELETE/);
  });

  it("honours PUMPERLY_BNETZA_MIN_STATIONS", async () => {
    vi.stubEnv("PUMPERLY_BNETZA_MIN_STATIONS", "40");
    const stub = await setup({
      results: [[{ count: BigInt(42) }], [{ count: BigInt(0) }], [{ count: BigInt(0) }]],
    });
    const { BNetzAScraper } = await import("./bnetza");

    await new BNetzAScraper().run();

    expect(stub.queries).toHaveLength(3); // 42 now clears the lowered floor
  });

  it("ignores a nonsensical floor rather than disabling the guard", async () => {
    vi.stubEnv("PUMPERLY_BNETZA_MIN_STATIONS", "not-a-number");
    const stub = await setup({ results: [[{ count: BigInt(42) }]] });
    const { BNetzAScraper } = await import("./bnetza");

    await new BNetzAScraper().run();

    expect(stub.queries).toHaveLength(1); // fell back to the 10,000 default
  });

  it("does not clean up after a run that reported errors", async () => {
    const stub = await setup({ errors: ["Station batch 0-500: boom"] });
    const { BNetzAScraper } = await import("./bnetza");

    const result = await new BNetzAScraper().run();

    expect(stub.queries).toHaveLength(0);
    expect(result.errors).toEqual(["Station batch 0-500: boom"]);
  });

  it("reports a cleanup failure instead of throwing out of run()", async () => {
    const { PrismaClient } = await import("../generated/prisma/client");
    const { BaseScraper } = await import("./base");
    vi.mocked(PrismaClient).mockImplementation(function () {
      return {
        $queryRawUnsafe: vi.fn(async () => {
          throw new Error("connection reset");
        }),
        $disconnect: vi.fn(async () => {}),
      };
    } as never);
    vi.spyOn(BaseScraper.prototype, "run").mockResolvedValue({
      country: "DE",
      source: "bnetza",
      stationsUpserted: 74223,
      pricesUpserted: 0,
      durationMs: 1000,
      errors: [],
    });
    const { BNetzAScraper } = await import("./bnetza");

    const result = await new BNetzAScraper().run();

    expect(result.errors).toEqual(["Cleanup: connection reset"]);
  });
});
