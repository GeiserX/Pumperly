# Environment variables

This page lists every environment variable Pumperly reads. Each row gives the default, what the variable changes, and the file that reads it. The configuration pages explain when you would want each setting. This page is the one place that states every default.

## How settings are read {#how-settings-are-read}

All configuration comes from environment variables. There is no configuration file and no settings screen.

Where the variables come from depends on how you run Pumperly:

| How you run it | Where to set variables |
|---|---|
| Docker Compose | The app service's `environment:` block, or an `env_file:` that points at your `.env`. See [Run with Docker Compose](../getting-started/docker-compose.md). |
| Helm | Chart values. The common variables have a value of their own, and `extraEnv` or `extraEnvFrom` covers the rest. See [Helm values](#helm-values) below. |
| Source checkout | A `.env` file in the repository root. `npm run dev`, the scraper CLI (`npm run scraper:run`) and the Prisma CLI all load it. |

The repository ships [`.env.example`](https://github.com/GeiserX/Pumperly/blob/main/.env.example) as a starting point. Copy it to `.env` and fill in what you need. Git ignores `.env`, so a key you put there stays out of commits.

!!! note "Restart after every change"
    Many variables are read once, when a module loads or when the scheduler starts. Restart the app after you change any of them. Under Compose, `docker compose up -d` recreates the container with the new values. `docker compose restart` does not read `.env` again.

### Parsing rules {#parsing-rules}

The variables are not parsed by one shared routine. Each file reads its own. The rules that differ are worth knowing:

- **Two on/off switches, two conventions.** [`PUMPERLY_CLUSTER_STATIONS`](#pumperly_cluster_stations) is on only for the word `true`, in any case. `1` or `yes` turn clustering off. [`PUMPERLY_EV_ENABLED`](#pumperly_ev_enabled) is off only for exactly `0`. `false` or `no` leave EV scraping on.
- **Most tuning numbers fall back to their default** when the value is not a number or is out of range. The table for each variable says so.
- **Three numbers do not fall back.** A bad [`VALHALLA_MAX_INFLIGHT`](#valhalla_max_inflight) stops routing. A bad [`PUMPERLY_SCRAPE_INTERVAL_<KEY>`](#pumperly_scrape_interval_key) makes that scraper run back to back. An empty [`PUMPERLY_OCM_TILE_DELAY_MS`](#pumperly_ocm_tile_delay_ms) means no delay at all.
- **An empty value is not the same as unset.** `NAME=` in a `.env` file, or `NAME: ""` in Compose, sets the variable to an empty string. For most variables that behaves like unset. The exceptions are the three above and `PUMPERLY_CLUSTER_STATIONS`, which an empty value turns off. Delete the line instead of leaving it empty.

## Database {#database}

Feature page: [Backing up the database](../operations/backup-and-restore.md).

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="database_url"></span>`DATABASE_URL` | none, **required** | `src/lib/db.ts`, every scraper, `prisma.config.ts` | PostgreSQL connection string, for example `postgresql://pumperly:change-me@pumperly-db:5432/pumperly`. The database needs the PostGIS extension. Without the variable, the first request that touches the database fails with `DATABASE_URL environment variable is not set`. The Prisma CLI (`npx prisma migrate deploy`) reads the same variable through `prisma.config.ts`. Percent-encode special characters in the password. |

The database container in [`docker/docker-compose.yml`](https://github.com/GeiserX/Pumperly/blob/main/docker/docker-compose.yml) is configured with the PostGIS image's own variables. Pumperly does not read them. They only have to match the user, password and database name in `DATABASE_URL`:

```yaml title="docker/docker-compose.yml"
--8<-- "docker/docker-compose.yml"
```

This file publishes PostgreSQL on host port 5433, so a checkout on the same machine connects with `postgresql://pumperly:pumperly@localhost:5433/pumperly`. Choose a real password for anything reachable from a network.

## Map defaults {#map-defaults}

Feature page: [Countries and scrape schedule](../configuration/countries-and-schedule.md#default-country-and-fuel).

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="pumperly_default_country"></span>`PUMPERLY_DEFAULT_COUNTRY` | `ES` | `src/lib/config.ts` | Country whose centre and zoom the map opens on. Must be an upper-case code from the [country table](../configuration/countries-and-schedule.md#default-country-and-fuel). An unknown code, or a lower-case one, opens on Spain. It is also the source of the default fuel. |
| <span id="pumperly_default_fuel"></span>`PUMPERLY_DEFAULT_FUEL` | the default country's fuel, such as `B7` for Spain | `src/lib/config.ts` | Fuel selected when the map opens. Use a code from [Fuel types](fuel-types.md), for example `E10` or `EV`. The value is not checked. A `fuel` parameter in a [share link](../using/links.md) wins over it. |
| <span id="pumperly_cluster_stations"></span>`PUMPERLY_CLUSTER_STATIONS` | `true` | `src/lib/config.ts` | Groups nearby stations into clusters at low zoom. Only `true`, in any case, turns it on. Any other value turns it off. Clustering is always off while a route is shown. |

## Countries and scheduling {#countries-and-scheduling}

Feature page: [Countries and scrape schedule](../configuration/countries-and-schedule.md).

A scraper key names one scheduled scraper. Most are a country code (`ES`). The others are `AU_NSW`, `EV_<CC>` for Open Charge Map, `EV_ES_REVE`, `EV_DE_BNETZA` and `STATIC_<SOURCE>`. [Scraper keys](../configuration/countries-and-schedule.md#scraper-keys) lists them.

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="pumperly_enabled_countries"></span>`PUMPERLY_ENABLED_COUNTRIES` | unset, meaning every scraper | `src/instrumentation.ts`, `src/lib/config.ts` | Comma-separated scraper keys. Case and spaces do not matter. A plain country code also enables that country's `EV_` scraper. Unknown codes are ignored without a warning. An empty value means unset. A value where nothing matches schedules nothing. [Choosing countries](../configuration/countries-and-schedule.md#choosing-countries) has the full rules. |
| <span id="pumperly_scrape_interval_hours"></span>`PUMPERLY_SCRAPE_INTERVAL_HOURS` | unset, meaning each scraper's own default | `src/instrumentation.ts` | Hours between runs, for every scraper at once. Decimals work. `0` turns off all automatic scraping, including scrapers that have their own override. A negative value or one that is not a number means the defaults. Above about 596 hours the timer breaks and scrapers run back to back. |
| <span id="pumperly_scrape_interval_key"></span>`PUMPERLY_SCRAPE_INTERVAL_<KEY>` | the scraper's default, see [How often scrapers run](../configuration/countries-and-schedule.md#how-often-scrapers-run) | `src/instrumentation.ts` | Hours between runs for one scraper key, for example `PUMPERLY_SCRAPE_INTERVAL_FR=0.5` or `PUMPERLY_SCRAPE_INTERVAL_EV_ES_REVE=1`. Beats the global interval. `0` or a negative value turns that scraper off. The value must be a number between 0 and about 596. An empty value or one that is not a number is not caught: the scraper then runs back to back and fills the log with skip warnings. |

## Price validation {#price-validation}

Feature page: [How scrapers work](../data/how-scrapers-work.md).

Every scraper run drops prices that cannot be real before it writes anything. A price of zero or less is always dropped. Hydrogen, CNG, LNG and AdBlue prices must be at least 0.05 and below 100, in any currency.

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="pumperly_price_min"></span>`PUMPERLY_PRICE_MIN` | `0.30` | `src/scrapers/base.ts` | Lowest accepted price per litre for prices in EUR, GBP and CHF. A value that is not a number means the default. |
| <span id="pumperly_price_max"></span>`PUMPERLY_PRICE_MAX` | `4.00` | `src/scrapers/base.ts` | Highest accepted price per litre for prices in EUR, GBP and CHF. A value that is not a number means the default. |

Prices in every other currency are checked against a fixed band per currency, such as 200 to 2,000 for HUF. A currency with no band of its own gets a wide default of 0.1 to 100,000. The bands live in `PRICE_BANDS` in [`src/scrapers/base.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/base.ts) and have no variable. See [Currencies and exchange rates](currencies.md).

!!! note "The comment in `.env.example` is out of date"
    `.env.example` says other currencies use 25 times the maximum. The code uses the fixed per-currency bands described above.

## Routing {#routing}

Feature page: [Routing with Valhalla](../configuration/routing-valhalla.md).

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="valhalla_url"></span>`VALHALLA_URL` | unset | `src/lib/valhalla.ts` | Base URL of a Valhalla server, without a trailing slash, for example `http://pumperly-valhalla:8002`. Pumperly appends `/route`. Unset turns route planning off: `/api/route` answers 502 and no detour times are computed. |
| <span id="valhalla_max_inflight"></span>`VALHALLA_MAX_INFLIGHT` | `6` | `src/lib/valhalla.ts` | Most Valhalla requests the app runs at the same time, across all visitors. Further requests wait in a queue. Must be a whole number of 1 or more. `0`, an empty value or one that is not a number leaves no slot at all, so routing requests queue and never reach Valhalla. |
| <span id="pumperly_max_detour_stations"></span>`PUMPERLY_MAX_DETOUR_STATIONS` | `150` | `src/app/api/route-detour/route.ts` | Most stations one detour request may route. Extra stations are thinned out evenly along the route. The request itself is limited to 150 stations, so this setting can only lower the cap. A value below 1 or not a number means the default. |

## Geocoding {#geocoding}

Feature page: [Geocoding with Photon](../configuration/geocoding-photon.md).

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="photon_url"></span>`PHOTON_URL` | unset | `src/lib/photon.ts` | Base URL of a Photon server, without a trailing slash, for example `http://pumperly-photon:2322`. Pumperly calls `/api` on it. Unset makes `/api/geocode` return an empty list, so the search boxes find nothing. |

## EV charging {#ev-charging}

Feature pages: [EV charging sources](../data/ev-sources.md) and [API keys](../configuration/api-keys.md).

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="pumperly_ev_enabled"></span>`PUMPERLY_EV_ENABLED` | on | `src/instrumentation.ts` | Only the exact value `0` turns off every EV charger scraper, including REVE and BNetzA. Any other value leaves them on. It does not depend on whether an Open Charge Map key is set. |
| <span id="pumperly_de_ev_source"></span>`PUMPERLY_DE_EV_SOURCE` | `bnetza` | `src/scrapers/germany-ev-source.ts` | Which source supplies German chargers. `ocm`, in any case, picks Open Charge Map. Anything else picks the BNetzA Ladesäulenregister. The two never run together. |
| <span id="pumperly_bnetza_min_stations"></span>`PUMPERLY_BNETZA_MIN_STATIONS` | `10000` | `src/scrapers/bnetza.ts` | Stations a BNetzA run must refresh before it deletes chargers that left the register and retires Open Charge Map's German rows. A safety floor: a damaged download cannot empty the map. A value below 1 or not a number means the default. |
| <span id="pumperly_reve_pages_per_run"></span>`PUMPERLY_REVE_PAGES_PER_RUN` | `4` | `src/scrapers/reve.ts` | Pages of 100 locations each REVE run fetches. Values above 5 are lowered to 5, the API's hourly limit. A value below 1 or not a number means the default. |
| <span id="pumperly_reve_cutover_ratio"></span>`PUMPERLY_REVE_CUTOVER_RATIO` | `0.95` | `src/scrapers/reve.ts` | Share of the REVE registry that must be stored before Open Charge Map's Spanish rows are deleted. Must be above 0 and at most 1. Anything else means the default. |

## API keys {#api-keys}

Feature page: [API keys](../configuration/api-keys.md). Every key is optional. Without it, the source it unlocks is skipped or fails, and the rest of Pumperly keeps working.

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="tankerkoenig_api_key"></span>`TANKERKOENIG_API_KEY` | unset | `src/scrapers/germany.ts` | Germany's fuel prices from Tankerkönig. Without it every German fuel run fails and the last prices stay. |
| <span id="fuelprices_dk_api_key"></span>`FUELPRICES_DK_API_KEY` | unset | `src/scrapers/denmark.ts` | Denmark's fuel prices from fuelprices.dk. Without it the scraper tries a fallback feed that no longer answers. |
| <span id="pumperly_ocm_api_key"></span>`PUMPERLY_OCM_API_KEY` | unset | `src/scrapers/ocm.ts` | Open Charge Map, the EV source for every country without an official registry. Without it every `EV_<CC>` run logs `PUMPERLY_OCM_API_KEY not set, skipping` and writes nothing. |
| <span id="pumperly_reve_api_key"></span>`PUMPERLY_REVE_API_KEY` | unset | `src/scrapers/reve.ts`, `src/scrapers/spain-ev-source.ts` | Mapa REVE, Spain's official charger registry. When set, Spain's chargers come from REVE instead of Open Charge Map. |
| <span id="nsw_fuel_api_key"></span>`NSW_FUEL_API_KEY` | unset | `src/scrapers/australia-nsw.ts` | New South Wales FuelCheck, together with `NSW_FUEL_API_SECRET`. Without both, the `AU_NSW` scraper fails and only Western Australia updates. |
| <span id="nsw_fuel_api_secret"></span>`NSW_FUEL_API_SECRET` | unset | `src/scrapers/australia-nsw.ts` | The secret that goes with `NSW_FUEL_API_KEY`. |

## Open Charge Map tuning {#open-charge-map-tuning}

Open Charge Map cuts every response at 5,000 results. For a large country the scraper splits the map into smaller boxes and asks again. These variables bound that work. The defaults suit the free API. Change them only if your logs show rate limiting or partial coverage.

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="pumperly_ocm_max_requests"></span>`PUMPERLY_OCM_MAX_REQUESTS` | `800` | `src/scrapers/ocm.ts` | Most requests one country may make in one run. Each country also stops after 15 minutes of active fetching. When either limit is reached the run keeps what it has and logs `coverage may be partial`. A value of 0 or less, or not a number, means the default. |
| <span id="pumperly_ocm_tile_delay_ms"></span>`PUMPERLY_OCM_TILE_DELAY_MS` | `600` | `src/scrapers/ocm.ts` | Pause between box requests, in milliseconds. A negative value or one that is not a number means the default. `0`, or an empty value, means no pause. Keep it well above 0: Open Charge Map answers bursts with HTTP 429. |
| <span id="pumperly_ocm_max_concurrency"></span>`PUMPERLY_OCM_MAX_CONCURRENCY` | `1` | `src/scrapers/ocm.ts` | Open Charge Map requests in flight at once, shared by every country. The default runs one request at a time. A value below 1 or not a number means the default. |
| <span id="pumperly_ocm_trust_span_deg"></span>`PUMPERLY_OCM_TRUST_SPAN_DEG` | `2` | `src/scrapers/ocm.ts` | Widest box, in degrees, whose result count the scraper trusts. Open Charge Map under-reports counts for large boxes, so a wider box that returns any result is always split. A value of 0 or less, or not a number, means the default. |

## Set by the runtime {#set-by-the-runtime}

You do not normally set these. The Docker image or Next.js sets them.

| Variable | Value | Read by | Notes |
|---|---|---|---|
| <span id="node_env"></span>`NODE_ENV` | `production` in the image | `src/lib/db.ts` and Next.js | Outside production, the database client is reused across hot reloads. |
| <span id="next_runtime"></span>`NEXT_RUNTIME` | set by Next.js | `src/instrumentation.ts` | The scheduler starts only when this is `nodejs`. |
| <span id="port"></span>`PORT` | `3000` in the image | Next.js server | Port the app listens on inside the container. |
| <span id="hostname"></span>`HOSTNAME` | `0.0.0.0` in the image | Next.js server | Address the app binds to inside the container. |
| <span id="next_telemetry_disabled"></span>`NEXT_TELEMETRY_DISABLED` | `1` in the image | Next.js | Turns off Next.js telemetry. |

The values come from [`docker/Dockerfile`](https://github.com/GeiserX/Pumperly/blob/main/docker/Dockerfile).

## Tests {#tests}

| Variable | Default | Read by | Notes |
|---|---|---|---|
| <span id="skip_integration"></span>`SKIP_INTEGRATION` | unset | `src/app/api/route-stations/route-stations.integration.test.ts` | `1` skips the integration suite, which starts a PostGIS container through Docker. See [Contributing](../contributing.md). |

## Helm values {#helm-values}

Feature page: [Run on Kubernetes with Helm](../getting-started/kubernetes.md).

The chart turns these values into variables. An empty value leaves the variable unset. The chart's schema requires strings, so quote numbers and booleans, for example `scrapeIntervalHours: "6"`.

| Helm value | Chart default | Sets |
|---|---|---|
| `config.defaultCountry` | `"ES"` | [`PUMPERLY_DEFAULT_COUNTRY`](#pumperly_default_country) |
| `config.enabledCountries` | `""` | [`PUMPERLY_ENABLED_COUNTRIES`](#pumperly_enabled_countries) |
| `config.defaultFuel` | `""` | [`PUMPERLY_DEFAULT_FUEL`](#pumperly_default_fuel) |
| `config.clusterStations` | `"true"` | [`PUMPERLY_CLUSTER_STATIONS`](#pumperly_cluster_stations) |
| `config.scrapeIntervalHours` | `""` | [`PUMPERLY_SCRAPE_INTERVAL_HOURS`](#pumperly_scrape_interval_hours) |
| `config.evEnabled` | `""` | [`PUMPERLY_EV_ENABLED`](#pumperly_ev_enabled) |
| `apiKeys.tankerkoenig` | `""` | [`TANKERKOENIG_API_KEY`](#tankerkoenig_api_key), stored in the chart's Secret |
| `apiKeys.openChargeMap` | `""` | [`PUMPERLY_OCM_API_KEY`](#pumperly_ocm_api_key), stored in the chart's Secret |
| `apiKeys.fuelpricesDk` | `""` | [`FUELPRICES_DK_API_KEY`](#fuelprices_dk_api_key), stored in the chart's Secret |
| `postgis.*`, `externalDatabase.*`, `existingSecret` | bundled PostGIS | [`DATABASE_URL`](#database_url), read from a Secret |
| `valhalla.enabled`, `externalServices.valhallaUrl` | off | [`VALHALLA_URL`](#valhalla_url). With `valhalla.enabled`, it points at the chart's own Valhalla service on port 8002. |
| `photon.enabled`, `externalServices.photonUrl` | off | [`PHOTON_URL`](#photon_url). With `photon.enabled`, it points at the chart's own Photon service on port 2322. |
| `extraEnv`, `extraEnvFrom` | empty | Any other variable on this page |

Every variable without a chart value of its own, such as `PUMPERLY_REVE_API_KEY` or a per-scraper interval, goes in `extraEnv`:

```yaml title="values.yaml"
extraEnv:
  - name: PUMPERLY_SCRAPE_INTERVAL_FR
    value: "0.5"
  - name: PUMPERLY_REVE_API_KEY
    valueFrom:
      secretKeyRef:
        name: pumperly-extra-keys
        key: reve
```

## The shipped example file {#the-shipped-example-file}

This is `.env.example` as it ships. Where its comments differ from the tables above, the tables describe what the code does.

??? example "`.env.example`"

    ```bash
    --8<-- ".env.example"
    ```
