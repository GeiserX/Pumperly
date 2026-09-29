# Adding a country

This page walks a contributor through adding a new country's fuel prices to Pumperly: choosing a source, writing the scraper and its test, registering it everywhere it needs to be, and proving it works before the pull request. Read [How scrapers work](how-scrapers-work.md) first. This page assumes you know what `fetch()`, `source` and `externalId` are.

A new country is one scraper plus small entries in about a dozen files. Most of those entries are one line.

## First, the source

Pumperly only uses sources it is allowed to use, and it identifies itself honestly. These rules come before any code. A pull request that breaks one will not be merged.

!!! warning "Source rules"
    - **Public.** The data is published for anyone to read: an open data portal, a public API, or a public website. A free API key that the publisher issues for API access is fine. A key or token taken out of someone's mobile app or website is not.
    - **Allowed by robots.txt.** Check the source's `robots.txt` for the exact paths the scraper fetches. If it disallows them, the source is out.
    - **Licensed for reuse.** The terms or licence must allow showing the data on a public map. Note the licence name and any condition, such as attribution or non-commercial use. Both go into the attribution list and the docs.
    - **Honest identity.** Send a `User-Agent` that names Pumperly, such as `Pumperly/1.0`. Never send a browser's or an app's user agent, and never work around a block. If a source blocks Pumperly later, each run fails and writes nothing, the last good prices stay, and [Coverage and status](coverage.md) lists the country as blocked.
    - **Polite.** Prefer one bulk download over one request per station. Stay inside any published rate limit. Pick a schedule no faster than the source updates.

Write what you found into the header comment of the scraper: the endpoint, who publishes it, the licence, what `robots.txt` says about the path, and any environment variable the scraper needs. The example in step 1 shows the shape.

If the country has no source that passes these rules, Pumperly can still hold hand-curated stations for it as a committed dataset. See [`src/scrapers/data/README.md`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/data/README.md).

## Every file you touch

The examples below use the placeholder country code `XX`, the country "Exampleland" and the scraper file `exampleland.ts`.

| File | What to add | Needed |
| --- | --- | --- |
| `src/scrapers/exampleland.ts` | The scraper class | Always |
| `src/scrapers/exampleland.test.ts` | Its unit tests | Always |
| `src/instrumentation.ts` | `XX` and `EV_XX` intervals, the import, the `XX` and `EV_XX` factories | Always |
| `src/scrapers/cli.ts` | The import, the `XX` and `EV_XX` entries | Always |
| `src/lib/config.ts` | A `COUNTRIES` entry | Always |
| `src/components/map/country-markers.tsx` | A flag in `FLAG` | Always |
| `src/components/nav/stats-dropdown.tsx` | A flag in its own `FLAG` | Always |
| `src/components/nav/legal-modal.tsx` | The source's attribution | Always |
| `.env.example` | The code in the `Supported:` comment, and any new variable | Always |
| `README.md` | A row in the fuel price table and the code in the supported countries list | Always |
| `docs/` | Coverage and source pages, and any new variable | Always |
| `src/scrapers/base.ts` | A price band in `PRICE_BANDS` | New currency |
| `src/lib/currency.tsx` | The currency in `Currency`, `CURRENCIES` and `REGION_TO_CURRENCY` | New currency |
| `src/app/api/exchange-rates/route.ts` | A fallback rate | New currency the ECB does not publish |

## 1. Write the scraper

Create `src/scrapers/exampleland.ts`. The class names the country and the source, and `fetch()` turns the upstream response into stations and prices. A minimal shape, for a source that publishes one JSON array:

```ts
import { BaseScraper, type RawFuelPrice, type RawStation } from "./base";
import type { FuelType } from "../types/station";

// ---------------------------------------------------------------------------
// Exampleland: national fuel price open data
// ---------------------------------------------------------------------------
// Endpoint: https://data.example.com/fuel/stations.json (one bulk request)
// Publisher and licence: <publisher>, <licence and its conditions>
// robots.txt: <what it says about this path>
// Prices in EUR per litre. Env: none.
// ---------------------------------------------------------------------------

const DATA_URL = "https://data.example.com/fuel/stations.json";

// Exampleland's bounding box. Rows outside it have broken coordinates.
const LAT_MIN = 40.0;
const LAT_MAX = 45.0;
const LON_MIN = 10.0;
const LON_MAX = 15.0;

// Feed field -> Pumperly fuel code. Map a field only when it is that fuel.
const FUEL_FIELDS: ReadonlyArray<readonly [string, FuelType]> = [
  ["petrol95", "E5"],
  ["diesel", "B7"],
];

interface FeedStation {
  id: number;
  lat: number;
  lon: number;
  brand: string | null;
  address: string | null;
  town: string | null;
  region: string | null;
  prices: Record<string, number | null> | null;
}

export class ExamplelandScraper extends BaseScraper {
  readonly country = "XX";
  readonly source = "exampleland_open_data";

  async fetch(): Promise<{ stations: RawStation[]; prices: RawFuelPrice[] }> {
    const res = await fetch(DATA_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Pumperly/1.0",
      },
      signal: AbortSignal.timeout(60_000),
    });
    // Throwing makes the run a no-op: nothing is deleted.
    if (!res.ok) throw new Error(`Exampleland feed returned HTTP ${res.status}`);

    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new Error("Exampleland feed did not return an array");

    const stations: RawStation[] = [];
    const prices: RawFuelPrice[] = [];
    const seen = new Set<string>();

    for (const raw of data) {
      // One malformed row must not cost the whole country a run.
      if (raw === null || typeof raw !== "object") continue;
      const s = raw as FeedStation;
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      if (s.lat < LAT_MIN || s.lat > LAT_MAX || s.lon < LON_MIN || s.lon > LON_MAX) continue;

      const externalId = `xx-ex-${s.id}`;
      // Two rows with one id in the same upsert batch fail the whole batch.
      if (seen.has(externalId)) continue;
      seen.add(externalId);

      const brand = s.brand?.trim() || null;
      stations.push({
        externalId,
        name: brand ?? externalId,
        brand,
        address: s.address?.trim() || "",
        city: s.town?.trim() || "",
        province: s.region?.trim() || null,
        latitude: s.lat,
        longitude: s.lon,
        stationType: "fuel",
      });

      for (const [field, fuelType] of FUEL_FIELDS) {
        const price = s.prices?.[field];
        if (typeof price === "number" && price > 0) {
          prices.push({ stationExternalId: externalId, fuelType, price, currency: "EUR" });
        }
      }
    }

    return { stations, prices };
  }
}
```

### Choosing `source` and `externalId`

These two values decide which rows the scraper owns, so they must not change once the scraper ships.

- **`source`** is a short lowercase name with underscores, such as `miteco`, `cma` or `fuelo_pl`. Every price row the scraper writes carries it, and each run replaces exactly the rows with this name in this country. Renaming it later leaves the old rows behind for good.
- **`externalId`** comes from the source's own station id, with a short prefix naming the source, such as `xx-ex-`. It must be the same for the same station on every run, or each run creates new stations. It must also be unique within the country across all sources, because the database keys stations on `(external_id, country)` and prices find their station by `external_id`. The prefix is what keeps two sources apart.
- Build an id from coordinates only when the source has no id at all. Round them to a fixed number of decimals. A station whose coordinates are corrected then becomes a new station, and the old one is removed by the orphan cleanup.

### Mapping fuels and prices

- Map each upstream fuel to one of the codes in [`src/types/fuel.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/types/fuel.ts). [Fuel types](../reference/fuel-types.md) explains them. Map a field only when it really is that fuel. The Swedish scraper drops E85 rather than file it as E10, because an E85 price would then show to everyone filtering for E10.
- Prices are per litre in the local currency. Gas fuels priced per kilogram, such as CNG, keep that unit.
- Leave out a fuel with no price. Do not send zero or a placeholder. The base class would drop it anyway, but a clean list makes the tests clearer.
- If the price has a decimal comma, or comes in cents, convert it in `fetch()`. The price band check in the base class drops what slips through, but it cannot fix it.

## 2. Test the scraper

Create `src/scrapers/exampleland.test.ts`. Tests mock the database modules and stub the global `fetch`, so they need no network and no database. [`src/scrapers/sweden.test.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/sweden.test.ts) is a complete example to copy from. The setup is:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: vi.fn() }));
vi.mock("../generated/prisma/client", () => ({ PrismaClient: vi.fn() }));

function mockFeed(payload: unknown, ok = true, status = 200) {
  vi.mocked(fetch).mockImplementation(async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as Response);
}

describe("ExamplelandScraper", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("has correct country and source", async () => {
    const { ExamplelandScraper } = await import("./exampleland");
    const scraper = new ExamplelandScraper();
    expect(scraper.country).toBe("XX");
    expect(scraper.source).toBe("exampleland_open_data");
  });

  it("throws on an HTTP error", async () => {
    const { ExamplelandScraper } = await import("./exampleland");
    mockFeed({ error: "unavailable" }, false, 503);
    await expect(new ExamplelandScraper().fetch()).rejects.toThrow("HTTP 503");
  });
});
```

Cover at least:

- the request goes to the expected URL, in the expected number of requests;
- a realistic row becomes the right station and the right prices;
- every mapped fuel field lands on its fuel code, and every unmapped one is dropped;
- rows outside the bounding box, with missing coordinates, or that are not objects are skipped;
- repeated ids are de-duplicated;
- an HTTP error and a response of the wrong shape both throw.

Run your file alone with `npx vitest run src/scrapers/exampleland.test.ts`, then the whole suite with `npm test`.

## 3. Register it with the scheduler

In [`src/instrumentation.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/instrumentation.ts), add four things. The `EV_XX` key gives the country OpenChargeMap EV chargers. The OpenChargeMap scraper takes any country code, so it needs no other setup.

```ts
// In DEFAULT_INTERVALS: hours between runs, with a comment naming the source.
XX: 12,   // Exampleland open data: updated daily
EV_XX: 24,

// Inside register(), next to the other imports:
const { ExamplelandScraper } = await import("./scrapers/exampleland");

// In scraperFactories:
XX: () => new ExamplelandScraper(),
EV_XX: () => new OCMScraper("XX"),
```

Pick the interval from how often the source changes. A source updated once a day gains nothing from hourly requests.

If the country already has a scraper and you are adding a second source for it, give the new one its own key, such as `AU_NSW` next to `AU`. Do not add a second `EV_XX` key.

## 4. Register it with the CLI

In [`src/scrapers/cli.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/cli.ts), import the class and add both keys to `SCRAPERS`:

```ts
import { ExamplelandScraper } from "./exampleland";

// In SCRAPERS:
XX: [() => new ExamplelandScraper()],
EV_XX: [() => new OCMScraper("XX")],
```

A second source for an existing country goes into that country's array, as `AU` does, so `--country=XX` runs both.

!!! note "The registry test checks EV keys only"
    [`src/scrapers/cli.test.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/cli.test.ts) fails when an `EV_` key is in `DEFAULT_INTERVALS` but missing from the factories in `instrumentation.ts` or from `cli.ts`, or when those two files list different `EV_` keys. Nothing checks the fuel keys. Check by hand that `XX` is in all three places.

## 5. Add the country to the map

In [`src/lib/config.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/lib/config.ts), add a `COUNTRIES` entry:

```ts
XX: { code: "XX", name: "Exampleland", center: [12.5, 42.5], zoom: 7, defaultFuel: "E5" },
```

| Field | Meaning |
| --- | --- |
| `name` | The country's own name for itself, as the other entries use: `Deutschland`, `Sverige`. |
| `center` | `[longitude, latitude]` of the view when the country is picked. Longitude comes first. |
| `zoom` | Map zoom for that view. Large countries use 4 to 5, small ones 8 to 9. |
| `defaultFuel` | The fuel shown first, usually the most common petrol or diesel code there. |

Without this entry the stations still appear, but the country gets no marker on the world view, cannot be chosen as `PUMPERLY_DEFAULT_COUNTRY`, and is left out of the enabled countries the app reports.

Then add the country's flag to both `FLAG` tables. They are separate copies in [`country-markers.tsx`](https://github.com/GeiserX/Pumperly/blob/main/src/components/map/country-markers.tsx) and [`stats-dropdown.tsx`](https://github.com/GeiserX/Pumperly/blob/main/src/components/nav/stats-dropdown.tsx). A missing flag falls back to a generic symbol.

## 6. A new currency

Skip this step if the country uses a currency Pumperly already handles. [Currencies and exchange rates](../reference/currencies.md) lists them.

1. **Price band.** Add the currency to `PRICE_BANDS` in [`src/scrapers/base.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/base.ts), with a plausible per-litre minimum and maximum. Without a band the currency falls back to 0.1 to 100,000, which lets prices in the wrong unit through.
2. **Display.** In [`src/lib/currency.tsx`](https://github.com/GeiserX/Pumperly/blob/main/src/lib/currency.tsx), add the code to the `Currency` type, an entry to `CURRENCIES` with its symbol, label and the decimals to show, and the country to `REGION_TO_CURRENCY` so visitors from there see it by default.
3. **Exchange rate.** Pumperly converts prices with the European Central Bank's daily reference rates. If the ECB does not publish the currency, add a fallback in [`src/app/api/exchange-rates/route.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/app/api/exchange-rates/route.ts), next to the existing ones for `BAM`, `MKD`, `RSD`, `ARS`, `MDL`, `ISK` and `TWD`. Without a rate, the map cannot convert the country's prices into a visitor's currency.

## 7. Credit the source

Add the source to `SourcesContent` in [`src/components/nav/legal-modal.tsx`](https://github.com/GeiserX/Pumperly/blob/main/src/components/nav/legal-modal.tsx). Government sources go under "Government open data" and others under "Third-party aggregators". Name the publisher and the licence, and repeat any condition the licence sets, such as non-commercial use.

## 8. Document it

- `.env.example`: add the code to the `Supported:` comment. If the scraper reads an environment variable, add it with a comment saying what it is and where to get it.
- `README.md`: add a row to the fuel prices table and the code to the supported countries list.
- This site: add the country to [Coverage and status](coverage.md) and [Fuel price sources](fuel-sources.md). A new variable goes into [Environment variables](../reference/environment-variables.md), and a key into [API keys](../configuration/api-keys.md). A new currency goes into [Currencies and exchange rates](../reference/currencies.md).

## 9. Prove it against a real database

Unit tests use a mocked database. Before you open the pull request, run the scraper once for real against a throwaway PostGIS database. That proves the rows land, the ids are stable, and nothing leaks into other countries.

Start an empty PostGIS and create the tables from the shipped migrations:

```bash
docker run --rm -d --name pumperly-scratch-db \
  -e POSTGRES_USER=pumperly \
  -e POSTGRES_PASSWORD=not-a-secret \
  -e POSTGRES_DB=pumperly \
  -p 127.0.0.1:55432:5432 \
  postgis/postgis:17-3.4

# -h 127.0.0.1 waits for the real server, not the one the image runs during init
until docker exec pumperly-scratch-db pg_isready -h 127.0.0.1 -U pumperly -d pumperly; do sleep 1; done

for f in prisma/migrations/*/migration.sql; do
  docker exec -i pumperly-scratch-db psql -U pumperly -d pumperly -v ON_ERROR_STOP=1 < "$f"
done

# The migrations create a narrower price column than schema.prisma declares
docker exec pumperly-scratch-db psql -U pumperly -d pumperly \
  -c 'ALTER TABLE fuel_prices ALTER COLUMN price TYPE DECIMAL(10,3)'
```

[Data model](../reference/data-model.md) explains why the migrations are applied directly here, and the price column step.

Run the scraper against it from a checkout set up as in [Local development](../getting-started/development.md). Export `DATABASE_URL` in the shell. The CLI also reads `.env`, but a variable already set in the shell wins.

```bash
export DATABASE_URL=postgresql://pumperly:not-a-secret@127.0.0.1:55432/pumperly
npx prisma generate
npm run scraper:run -- --country=XX
```

The run must end with `All scrapers completed successfully.` Then look at what it wrote:

```bash
docker exec -i pumperly-scratch-db psql -U pumperly -d pumperly <<'SQL'
-- Stations by type
SELECT station_type, count(*) FROM stations WHERE country = 'XX' GROUP BY 1;

-- Prices per fuel: are the ranges believable?
SELECT fp.source, fp.fuel_type, count(*), min(fp.price), max(fp.price), fp.currency
FROM fuel_prices fp JOIN stations s ON s.id = fp.station_id
WHERE s.country = 'XX'
GROUP BY 1, 2, 6 ORDER BY 1, 2;

-- A few stations to compare against the source by hand
SELECT external_id, name, city, ST_Y(geom) AS lat, ST_X(geom) AS lon
FROM stations WHERE country = 'XX' ORDER BY random() LIMIT 5;

-- Two stations within 25 m of each other: often one forecourt with two ids
SELECT a.external_id, b.external_id
FROM stations a JOIN stations b
  ON a.country = b.country AND a.id < b.id
 AND ST_DWithin(a.geom::geography, b.geom::geography, 25)
WHERE a.country = 'XX' LIMIT 20;
SQL
```

Check these before moving on:

- The station count is close to what the source says it publishes.
- The five sample stations sit where the source puts them, and their prices match the source.
- The price ranges fit the country's pump prices. If the run logged `Filtered out N invalid prices`, find out which prices and why. That line usually means a unit or parsing problem.
- Run the scraper a second time. The station count must not grow. If it does, the ids are not stable.
- No rows appeared for any other country.

Stop the database when you are done. `--rm` deletes it with everything in it:

```bash
docker stop pumperly-scratch-db
```

## 10. Prove the guards can fail

A test that stays green when the code it guards is removed tests nothing. For each guard in your scraper, run a **mutation test**: break the guard on purpose, run the test that covers it, and watch that test fail.

For example, delete the de-duplication line from `fetch()`:

```ts
if (seen.has(externalId)) continue;
```

Run `npx vitest run src/scrapers/exampleland.test.ts`. The de-duplication test must fail. Put the line back exactly as it was, confirm `git diff` shows only your intended changes, and run the tests again. Do the same for the bounding box, the shape check that throws, and any floor or condition that gates a delete. If a test stays green with its guard removed, fix the test.

## If the country already has a source

When the new scraper replaces a dead source for a country that is already covered, the old source's prices would stay forever next to the new ones. Use the handover pattern in [How scrapers work](how-scrapers-work.md#handing-a-country-over-to-a-new-source). Retire the old source's rows in a `run()` override, and only after a full, error-free run of the new one that clears a minimum station count. Test both sides. The cleanup must run after a healthy run and delete nothing after a failed or thin one.

## Open the pull request

Before you open it, check:

- [ ] The source passes every rule at the top of this page, and the header comment says so.
- [ ] `npm test` and `npm run lint` pass.
- [ ] The scraper ran once against a throwaway PostGIS, and a second run added no stations.
- [ ] Each guard has a test that you watched fail with the guard removed.
- [ ] `XX` and `EV_XX` are in `instrumentation.ts` (intervals and factories) and in `cli.ts`.
- [ ] `config.ts`, both flag tables, the attribution list, `.env.example`, `README.md` and the docs are updated.
- [ ] A new currency has a band, a display entry and, if the ECB lacks it, a fallback rate.

Describe the source in the pull request: the endpoint, the licence, what `robots.txt` allows, and how you checked the numbers against the source. [Contributing](../contributing.md) covers the rest of the process.
