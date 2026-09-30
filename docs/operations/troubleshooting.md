# Monitoring and troubleshooting

This page covers how to watch a running Pumperly, how to read its logs, and what the common failures mean. It ends with running a single country's scraper by hand.

## What to monitor

Pumperly has no dedicated health endpoint, and the Docker image declares no health check. Two endpoints are useful instead:

| Endpoint | What it proves |
|----------|----------------|
| `GET /api/config` | The web server answers. It reads configuration only and never touches the database. The Helm chart's startup, liveness and readiness probes call it. |
| `GET /api/stats` | The database answers. It returns, per country, the station count, the price count and `lastUpdate`, the time of the newest price. It answers HTTP 500 when the query fails. |

A green probe does not prove that the data is current, or that the map draws. Watch `lastUpdate` per country in `/api/stats`. A country whose `lastUpdate` stops moving has a source that fails. Look at the map itself after every upgrade, as described in [Checks after an upgrade](upgrading.md#after-an-upgrade).

```bash
curl -s https://pumperly.example.com/api/stats
```

## Reading the logs

The scrapers run inside the web process, so everything is in the app's log.

=== "Docker Compose"

    ```bash
    docker compose -f docker/docker-compose.yml logs -f app
    ```

    This follows the layout of [Run with Docker Compose](../getting-started/docker-compose.md), where the Pumperly service is `app` in `docker/docker-compose.yml`. The schema migrations run in the `migrate` service; read them with `logs migrate`.

=== "Helm"

    ```bash
    kubectl logs -f deployment/pumperly
    ```

    The pod also has init containers. `wait-for-database` logs `waiting for database` until PostGIS accepts connections. It gives up with `database did not become ready within <n> seconds` after `waitForDatabase.timeoutSeconds`, 300 by default. Read an init container's log with `-c <name>`:

    ```bash
    kubectl logs deployment/pumperly -c wait-for-database
    ```

Two kinds of line matter for scraping. A [scraper key](../reference/glossary.md#scraper-key) names one scheduled source: a country code such as `ES` for fuel prices, or `EV_` plus a country code such as `EV_FR` for chargers. The scheduler writes lines that start with `[scraper]` and the key. Each scraper writes lines that start with its source name in brackets, such as `[miteco]` or `[ocm]`. A source name can serve several countries: `anwb` covers the Netherlands, Belgium and Luxembourg, and `ocm` covers every Open Charge Map country. See [Fuel price sources](../data/fuel-sources.md) and [EV charging sources](../data/ev-sources.md) for which source serves which country.

### Scheduler lines

| Line | Meaning |
|------|---------|
| `[scraper] ES: scraping every 12h` | Written at start for each enabled key, with its interval. |
| `[scraper] ES: automatic scraping disabled` | The key's interval is `0`. |
| `[scraper] PUMPERLY_SCRAPE_INTERVAL_HOURS=0 — automatic scraping disabled` | All scraping is off. |
| `[scraper] Spain EV: using Mapa REVE (official registry) instead of OpenChargeMap` | `PUMPERLY_REVE_API_KEY` is set, so `EV_ES_REVE` runs instead of `EV_ES`. |
| `[scraper] Germany EV: using the BNetzA Ladesäulenregister instead of OpenChargeMap` | The default for Germany. Set `PUMPERLY_DE_EV_SOURCE=ocm` to use Open Charge Map instead. |
| `[scraper] ES: OK — <n> stations, <n> prices in <s>s` | A run finished without errors. |
| `[scraper] ES: 1 error(s) — <n> stations, <n> prices in <s>s` | A run finished with errors. The lines before it, from the scraper, say what went wrong. |
| `[scraper] ES: previous run still in progress — skipping this tick` | A run took longer than its interval. The scheduler skips a tick rather than run the same source twice at once. |

The first key runs 10 seconds after boot, and each following key 5 seconds after the one before. After that each key repeats on its own interval. See [Countries and scrape schedule](../configuration/countries-and-schedule.md).

### Request lines

Some API endpoints also log one line per request. The station endpoint the map calls writes:

```text
[stations] bbox=-3.75,40.38,-3.65,40.45 fuel=B7 → <n> stations (<n> with price)
```

If these lines report stations while the browser shows an empty map, the problem is in the browser. See [The map shows stations](upgrading.md#map-check).

### Lines from one scrape run

Every scraper goes through the same steps, in [`src/scrapers/base.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/base.ts). Each step logs a line, shown here for the Spanish fuel source, `miteco`:

| Order | Line | Meaning |
|-------|------|---------|
| 1 | `[miteco] Fetching data for ES ...` | The scraper asks the source for its data. Scraper-specific progress lines may follow. |
| 2 | `[miteco] Filtered out <n> invalid prices` | Prices outside the plausible range were dropped. See [Price band rejections](#price-band-rejections). Only written when `n` is above 0. |
| 3 | `[miteco] Fetched <n> stations, <n> price rows (dropped <n> with no prices)` | What the source returned. Fuel stations left with no valid price are dropped. Charging stations are always kept. |
| 4 | `[miteco] Aborted destructive replace: fetch returned 0 stations / <n> valid prices` | Nothing usable came back, so the run stops without changing the database. See [The empty-fetch guard](#the-empty-fetch-guard). |
| 5 | `[miteco] Upserted <n> stations` | Stations were inserted or updated. |
| 6 | `[miteco] Inserted <n> prices` | The source's prices for this country were replaced in one transaction. |
| 7 | `[miteco] Cleaned up <n> stations with no prices` | Fuel stations in the country that no source prices any more were deleted. |
| 7 | `[miteco] Skipped orphan cleanup: one or more station batches failed (would have deleted unwritten stations)` | A station write failed, so the cleanup did not run. The run reports an error. |
| any | `[miteco] Fatal error: <message>` | The run stopped. The message says why, often an HTTP status from the source. |

### What a failed run leaves behind

A failed run does not empty the map. When the fetch fails, the scraper stops before it touches the database. The source's last good prices stay, with the time they were scraped. The price replacement runs in one transaction, so readers never see a half-written country.

The cost is stale data. The prices on the map keep the age of the last good run, and `lastUpdate` in `/api/stats` stops moving. A source that keeps failing leaves its country frozen until it works again or you turn it off.

## Common scraper failures

### The source answers 403

A line such as `[<source>] Fatal error: <Source> HTTP 403` means the source refuses the request. Some sources block automated clients, some forbid them in their terms or `robots.txt`, and some refuse whole network ranges.

Do not try to work around a block. A source that blocks Pumperly stays down until the source changes its mind or offers an official way in, such as an API with a key. Check [Coverage and status](../data/coverage.md) for sources known to be blocked.

To stop the failing runs, turn the country off with `PUMPERLY_SCRAPE_INTERVAL_<KEY>=0`, for example `PUMPERLY_SCRAPE_INTERVAL_IE=0`. Its last prices stay on the map.

### The source answers 404

A 404 means the address Pumperly calls no longer exists. The source moved or retired its endpoint. This needs a change to the scraper's code. Check for a newer release, then search the [issues](https://github.com/GeiserX/Pumperly/issues), and open one if nobody has reported it.

### The source cannot be reached

Two messages mean the request never got an answer:

| Message | Meaning |
|---------|---------|
| `The operation was aborted due to timeout` | The source did not answer in time. Each scraper sets its own limit, from 10 seconds to 5 minutes. |
| `fetch failed` | The connection failed: DNS, a refused connection, or a network block. |

A slow source can recover on its own by the next run. A source that fails every time from your server, while it works from elsewhere, may only serve some regions or refuse cloud hosting ranges. Pumperly cannot fix that from inside the app. Turn the country off as above if you cannot reach the source from where you run.

### A missing API key

Most sources need no key. The ones that do behave differently when the key is missing:

| Variable | Used by | Without it |
|----------|---------|------------|
| `TANKERKOENIG_API_KEY` | `DE`, German fuel prices | Every run fails with `[tankerkoenig] Fatal error: TANKERKOENIG_API_KEY env var required. Register at https://onboarding.tankerkoenig.de`. |
| `PUMPERLY_OCM_API_KEY` | Every `EV_<country>` key that uses Open Charge Map | Each run logs `[ocm] PUMPERLY_OCM_API_KEY not set, skipping`, then `Aborted destructive replace`, and counts as 1 error. |
| `NSW_FUEL_API_KEY` and `NSW_FUEL_API_SECRET` | `AU_NSW`, New South Wales fuel prices | Every run fails with `[nsw_fuelcheck] Fatal error: NSW_FUEL_API_KEY and NSW_FUEL_API_SECRET must be set`. |
| `FUELPRICES_DK_API_KEY` | `DK`, Danish fuel prices | The scraper logs `No FUELPRICES_DK_API_KEY — falling back to DrivstoffAppen API` and tries the fallback feed. That feed no longer answers public requests, so the run fails, for example with `[fuelprices_dk] Fatal error: DrivstoffAppen auth failed: HTTP <status>`. |
| `PUMPERLY_REVE_API_KEY` | `EV_ES_REVE`, Spanish charging registry | No error. The scheduler runs `EV_ES` from Open Charge Map instead. |

EV scraping is on by default, whether or not an Open Charge Map key is set. Without the key, every Open Charge Map country logs one error per run. Set the key, or set `PUMPERLY_EV_ENABLED=0`. That turns off every `EV_` key, including the Spanish and German registries, which need no Open Charge Map key.

To stop a keyed source you do not want, set its interval to `0`, for example `PUMPERLY_SCRAPE_INTERVAL_DE=0` or `PUMPERLY_SCRAPE_INTERVAL_AU_NSW=0`. See [API keys](../configuration/api-keys.md) for where to get each key.

### The empty-fetch guard { #the-empty-fetch-guard }

A source can answer HTTP 200 with an empty list, or with data that parses but holds nothing usable. Replacing a country's prices with that would wipe the country from the map. The guard stops it:

```text
[miteco] Aborted destructive replace: fetch returned 0 stations / 0 valid prices
```

The run changes nothing and reports one error. The previous data stays.

The guard fires when no station survives the filters. That happens when:

- the source returned nothing,
- a keyed source skipped its fetch because the key is missing, or
- every price fell outside the price band, so every fuel station was dropped.

The guard only catches an empty result. A source that returns fewer stations than usual still replaces its prices, and fuel stations it no longer lists lose their prices and are cleaned up.

### Price band rejections { #price-band-rejections }

Before it writes anything, the scraper drops prices that cannot be real per-litre prices. Placeholder values and wrong units are the usual cause. The log says how many:

```text
[miteco] Filtered out <n> invalid prices
```

The ranges, from [`src/scrapers/base.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/base.ts):

| Prices | Accepted range |
|--------|----------------|
| Any price of 0 or less | Always rejected |
| `H2`, `CNG`, `LNG` and `ADBLUE`, in any currency | At least 0.05 and below 100 |
| EUR, GBP and CHF | From `PUMPERLY_PRICE_MIN` to `PUMPERLY_PRICE_MAX`, by default 0.30 to 4.00 |
| Other currencies | A fixed band per currency, listed below |
| A currency with no band | From 0.1 to 100,000 |

| Currency | Band | Currency | Band | Currency | Band |
|----------|------|----------|------|----------|------|
| HUF | 200 to 2,000 | BAM | 1 to 10 | NOK | 7 to 70 |
| RON | 3 to 30 | MDL | 10 to 100 | DKK | 6 to 60 |
| RSD | 60 to 600 | SEK | 6 to 60 | MXN | 8 to 100 |
| TRY | 10 to 400 | ISK | 100 to 700 | ARS | 200 to 20,000 |
| PLN | 2 to 20 | TWD | 15 to 80 | AUD | 0.5 to 5.0 |
| CZK | 10 to 150 | BGN | 1 to 10 | MKD | 30 to 300 |

A few rejected prices are normal. A rejected price for every station in a country usually means real prices moved outside the band. A fuel station left with no valid price is dropped from the run and then cleaned up, so it disappears from the map. If every station is dropped, the [empty-fetch guard](#the-empty-fetch-guard) keeps the old data instead.

For EUR, GBP and CHF, widen the range with `PUMPERLY_PRICE_MIN` and `PUMPERLY_PRICE_MAX`. The other bands are fixed in the code. Open an issue if one of them no longer fits real prices.

### Open Charge Map rate limits (429)

Open Charge Map answers HTTP 429 when it gets too many requests. The scraper waits and retries the same request up to 4 times. It honours the source's `Retry-After` header, or else waits 1, 2, 4 and 8 seconds, capped at 30:

```text
[ocm] FR: HTTP 429 — backing off 2000ms (retry 2/4)
```

After the fourth retry the run fails with `OCM HTTP 429: rate limited after 4 retries`, and the country keeps its previous chargers.

Large countries need many requests, because the API caps each answer at 5,000 results and the scraper splits the country into tiles. When a run hits its request or time budget, it keeps what it found and says so:

```text
[ocm] US: coverage may be partial — request budget (800), time budget (15min) or min tile size reached
```

These variables control the request rate:

| Variable | Default | Effect |
|----------|---------|--------|
| `PUMPERLY_OCM_MAX_CONCURRENCY` | `1` | Open Charge Map requests in flight at once, across all countries. Raising it makes 429s more likely. |
| `PUMPERLY_OCM_TILE_DELAY_MS` | `600` | Pause between tile requests, in milliseconds. Raise it if 429s persist. |
| `PUMPERLY_OCM_MAX_REQUESTS` | `800` | Request budget per country per run. |

### The Spanish charging registry rate limit

Mapa REVE allows 5 requests per hour. `EV_ES_REVE` runs hourly and reads a few pages per run. When it hits the limit, it stops for the hour and continues on the next run:

```text
[reve] HTTP 429 after <n> page(s) — hourly budget spent, resuming next run
```

This is expected and is not an error. While the registry fills in, Spain shows both Open Charge Map and registry pins. The log reports the progress:

```text
[reve] backfill <n>/<total> — keeping <n> OpenChargeMap row(s) until <target>
```

Once the registry reaches 95% of its reported total, the Open Charge Map rows for Spain are removed. [`PUMPERLY_REVE_CUTOVER_RATIO`](../reference/environment-variables.md#pumperly_reve_cutover_ratio) sets that share, `0.95` by default. See [EV charging sources](../data/ev-sources.md).

### The German charging registry keeps old rows

The BNetzA scraper only prunes rows the register no longer lists, and only retires Open Charge Map's German rows, after a healthy run. A run that refreshed fewer stations than `PUMPERLY_BNETZA_MIN_STATIONS`, 10,000 by default, skips that cleanup:

```text
[bnetza] Only <n> station(s) refreshed by this run (floor 10000) — skipping cleanup
```

This protects the map from a bad download. The next healthy run does the cleanup.

## Valhalla or Photon is not ready { #valhalla-or-photon-is-not-ready }

Routing needs Valhalla at `VALHALLA_URL`. Address search needs Photon at `PHOTON_URL`. Both are optional. The map and the scrapers work without them. See [Routing with Valhalla](../configuration/routing-valhalla.md) and [Geocoding with Photon](../configuration/geocoding-photon.md).

On first start, Valhalla builds its routing tiles and Photon imports its data. Both can take hours. Until they finish, routing and search fail in these ways:

| What you see | App log | Cause |
|--------------|---------|-------|
| Route planning fails, and `/api/route` answers 502 `Routing service unavailable` | `[route] Valhalla returned no routes`, or `no route` for a route with stops | `VALHALLA_URL` is not set, or Valhalla answered with an error. |
| Route planning fails, and `/api/route` answers 502 `Route calculation failed` | `[route] Calculation failed:` and the error | Valhalla cannot be reached, or did not answer within 10 to 15 seconds. |
| Search suggests nothing, and `/api/geocode` answers 200 with `[]` | Nothing | `PHOTON_URL` is not set, or Photon answered with an error. |
| Search fails, and `/api/geocode` answers 502 `Geocoding failed` | Nothing | Photon cannot be reached, or took more than 5 seconds. |

Test from the command line:

```bash
curl -s 'https://pumperly.example.com/api/geocode?q=Madrid'
curl -s -X POST https://pumperly.example.com/api/route \
  -H 'Content-Type: application/json' \
  -d '{"origin":[-3.70,40.42],"destination":[-3.60,40.45]}'
```

Coordinates are `[longitude, latitude]`. Then read the Valhalla or Photon container's own log to see how far its build or import has got.

## Run one country by hand { #run-by-hand }

The scraper command-line tool runs one or more sources once and prints a summary. Use it to test a source, to fill a country right away, or to see the full error of a failing run.

The Docker image holds only the built web app, so the tool runs from a checkout of the repository. Check out the tag of the release you run, so the scraper code matches:

```bash
git clone https://github.com/GeiserX/Pumperly.git
cd Pumperly
git checkout v1.14.0
npm ci
```

The tool reads `.env` in the checkout. Set `DATABASE_URL` to your database, as seen from where you run the tool, and add any API key the source needs. The shipped [`docker/docker-compose.yml`](https://github.com/GeiserX/Pumperly/blob/main/docker/docker-compose.yml) publishes PostGIS on host port `5433`:

```bash
DATABASE_URL=postgresql://pumperly:pumperly@localhost:5433/pumperly
```

That is the shipped password. Use your own if you changed it.

Then run it:

```bash
npm run scraper:run -- --country=ES
```

| Flag | Effect |
|------|--------|
| `--country=ES` | Runs one key. Case does not matter. |
| `--country=ES,FR,PT` | Runs several keys, one after another. |
| `--country=EV_PT` | Runs the Open Charge Map scraper for Portugal. `EV_ES_REVE` and `EV_DE_BNETZA` run the two registries. |
| `--country=all` | Runs every key, choosing one EV source each for Spain and Germany as the scheduler does. |
| `--once` | Accepted and ignored. Every invocation runs once. |

An unknown key stops the tool with `Unknown country "XX"` and the list of supported keys.

The tool prints each scraper's log lines, then a summary per source:

```text
=== Summary ===
  [miteco] ES: OK in <s>s
    Stations upserted: <n>
    Prices inserted:   <n>
```

A source with errors shows `ERRORS` and lists them. The tool exits with status 0 when every source succeeded and 1 when any failed, so a script can check it.

The tool's keys differ from the scheduler's in a few places:

- `AU` runs both Australian sources, Western Australia and New South Wales. The scheduler splits them into `AU` and `AU_NSW`.
- The tool has no `STATIC_` keys for the community datasets. Only the scheduler runs those.

!!! warning "Asking for `EV_ES` or `EV_DE` by name overrides the registry"
    Naming `EV_ES` or `EV_DE` runs Open Charge Map for that country, even when the registry is the configured source. That brings back the Open Charge Map rows the registry retired, and the map shows duplicate pins. Use `EV_ES_REVE` or `EV_DE_BNETZA` for those countries.

The tool writes to the same tables as the running app. The app's guard against overlapping runs only covers its own scheduler. Do not run a key by hand while the app is scraping the same key. Check the app's log first, or set that key's interval to `0` while you test.

## Troubleshooting table

| Symptom | Cause | Fix |
|---------|-------|-----|
| The map shows only its background, with no stations or clusters | The MapLibre worker under `/maplibre/` does not load. The API and routing keep working. | See [The map shows stations](upgrading.md#map-check). Check the browser's developer tools and the two worker files. |
| A country in `PUMPERLY_ENABLED_COUNTRIES` never scrapes, and has no `scraping every` line | The code is misspelled or unknown. Unknown codes are dropped without a warning. | Use the keys from [Countries and scrape schedule](../configuration/countries-and-schedule.md). New South Wales must be listed as `AU_NSW`; `AU` alone does not enable it. |
| A country's prices stop changing | Its source fails on every run. | Search the log for that source's `Fatal error` or `Aborted destructive replace` line, and see the sections above. |
| Scraper runs fail with `column "geom" of relation "stations" does not exist` | The schema was built from `schema.prisma` with `prisma db push`, not from the migrations. | Build the schema from `prisma/migrations`. See [the database schema](upgrading.md#migrations). |
| `/api/stats` answers HTTP 500 | The app cannot query the database. The log shows `Failed to query stats:` and the error. | Check `DATABASE_URL`, and that PostGIS runs and accepts connections. |
| Every visitor gets `Too many requests` from route planning | The per-client limit reads the client address from `X-Forwarded-For`, then `X-Real-IP`. Without either header, every visitor shares one budget. The route endpoints allow 30 requests a minute, and detour search 10. | Put Pumperly behind a reverse proxy that sets `X-Forwarded-For`, replacing any value the client sent. |
| Spain shows two pins for many chargers | The Spanish registry is still filling in, and Open Charge Map rows stay until it reaches 95% by default. | Wait. See [The Spanish charging registry rate limit](#the-spanish-charging-registry-rate-limit). |
| `previous run still in progress — skipping this tick` repeats for one key | Runs of that source take longer than its interval. | Raise the key's interval with `PUMPERLY_SCRAPE_INTERVAL_<KEY>`. |
| The Helm pod stays in `Init` | `wait-for-database` cannot reach PostGIS, or the `prisma-db-push` init container fails. With an external database, `wait-for-database` probes `externalDatabase.host`. | Read the init container's log with `-c <name>`. Set `externalDatabase.host`, or `waitForDatabase.enabled: false`. Set `databaseInit.enabled: false` and apply the migrations yourself, as in [Run on Kubernetes with Helm](../getting-started/kubernetes.md). |

## Reporting a bug { #reporting-a-bug }

Open an issue at [github.com/GeiserX/Pumperly/issues](https://github.com/GeiserX/Pumperly/issues). Include:

- the image tag you run, as pinned in your compose file or Helm values,
- how you run it: Docker Compose, Helm, or from source,
- the log lines around the failure, including the scraper's summary line,
- your `PUMPERLY_ENABLED_COUNTRIES` value, and whether you run Valhalla and Photon,
- for a map problem, the browser, and any errors from its developer console.

Remove API keys, passwords and your own hostnames from what you paste. The request lines in the log carry the map areas and rounded positions that visitors asked for, so leave out lines you do not need.

An issue with no activity for 14 days is marked stale, and closed 14 days after that.

A security problem is not a bug report. Do not open a public issue for it. Report it privately as described in [SECURITY.md](https://github.com/GeiserX/Pumperly/blob/main/SECURITY.md).
