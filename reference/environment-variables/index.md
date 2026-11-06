# Environment variables

This page lists every environment variable Pumperly reads. Each row gives the default, what the variable changes, and the file that reads it. The configuration pages explain when you would want each setting. This page is the one place that states every default.

## How settings are read

All configuration comes from environment variables. There is no configuration file and no settings screen.

Where the variables come from depends on how you run Pumperly:

| How you run it | Where to set variables |
| --- | --- |
| Docker Compose | The app service's `environment:` block, or an `env_file:` that points at your `.env`. See [Run with Docker Compose](<https://geiserx.github.io/Pumperly/getting-started/docker-compose/index.md>). |
| Helm | Chart values. The common variables have a value of their own, and `extraEnv` or `extraEnvFrom` covers the rest. See [Helm values](<#helm-values>) below. |
| Source checkout | A `.env` file in the repository root. `npm run dev`, the scraper CLI (`npm run scraper:run`) and the Prisma CLI all load it. |

The repository ships [`.env.example`](<https://github.com/GeiserX/Pumperly/blob/main/.env.example>) as a starting point. Copy it to `.env` and fill in what you need. Git ignores `.env`, so a key you put there stays out of commits.

> [!NOTE]
>
> **Restart after every change**
>
> Many variables are read once, when a module loads or when the scheduler starts. Restart the app after you change any of them. Under Compose, `docker compose up -d` recreates the container with the new values. `docker compose restart` does not read `.env` again.

### Parsing rules

The variables are not parsed by one shared routine. Each file reads its own. The rules that differ are worth knowing:

- **Two on/off switches, two conventions.** [`PUMPERLY_CLUSTER_STATIONS`](<#pumperly_cluster_stations>) is on only for the word `true`, in any case. `1` or `yes` turn clustering off. [`PUMPERLY_EV_ENABLED`](<#pumperly_ev_enabled>) is off only for exactly `0`. `false` or `no` leave EV scraping on.
- **Most tuning numbers fall back to their default** when the value is not a number or is out of range. The table for each variable says so.
- **Three numbers do not fall back.** A bad [`VALHALLA_MAX_INFLIGHT`](<#valhalla_max_inflight>) stops routing. A bad [`PUMPERLY_SCRAPE_INTERVAL_<KEY>`](<#pumperly_scrape_interval_key>) makes that scraper run back to back. An empty [`PUMPERLY_OCM_TILE_DELAY_MS`](<#pumperly_ocm_tile_delay_ms>) means no delay at all.
- **An empty value is not the same as unset.** `NAME=` in a `.env` file, or `NAME: ""` in Compose, sets the variable to an empty string. For most variables that behaves like unset. The exceptions are the three above and `PUMPERLY_CLUSTER_STATIONS`, which an empty value turns off. Delete the line instead of leaving it empty.

## Database

Feature page: [Backing up the database](<https://geiserx.github.io/Pumperly/operations/backup-and-restore/index.md>).

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | none, **required** | `src/lib/db.ts`, every scraper, `prisma.config.ts` | PostgreSQL connection string, for example `postgresql://pumperly:change-me@pumperly-db:5432/pumperly`. The database needs the PostGIS extension. Without the variable, the first request that touches the database fails with `DATABASE_URL environment variable is not set`. The Prisma CLI (`npx prisma migrate deploy`) reads the same variable through `prisma.config.ts`. Percent-encode special characters in the password. |

The database container in [`docker/docker-compose.yml`](<https://github.com/GeiserX/Pumperly/blob/main/docker/docker-compose.yml>) is configured with the PostGIS image's own variables. Pumperly does not read them. They only have to match the user, password and database name in `DATABASE_URL`:

docker/docker-compose.yml

```
# One image for the app and for the migrate service, so the migrations a
# release ships are the ones applied. The auto-tag workflow moves this pin.
x-app-image: &app-image
  image: drumsergio/pumperly:1.20.6

services:
  db:
    image: postgis/postgis:17-3.4
    container_name: pumperly-db
    restart: unless-stopped
    ports:
      - "5433:5432"
    environment:
      POSTGRES_USER: pumperly
      POSTGRES_PASSWORD: pumperly
      POSTGRES_DB: pumperly
    volumes:
      - pumperly-pgdata:/var/lib/postgresql/data
    healthcheck:
      # Over TCP: during the first start the image runs its init scripts on a
      # socket-only server, and a socket check would pass too early.
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U pumperly -d pumperly"]
      interval: 5s
      timeout: 5s
      retries: 5

  # One-shot: applies the SQL migrations shipped in the image that the
  # database has not recorded yet, then exits. See docker/migrate.mjs.
  migrate:
    <<: *app-image
    env_file: ../.env
    depends_on:
      db:
        condition: service_healthy
    command: ["node", "migrate.mjs"]
    restart: "no"

  app:
    <<: *app-image
    container_name: pumperly
    restart: unless-stopped
    env_file: ../.env
    depends_on:
      migrate:
        condition: service_completed_successfully
    ports:
      - "3000:3000"

volumes:
  pumperly-pgdata:
```

This file publishes PostgreSQL on host port 5433, so a checkout on the same machine connects with `postgresql://pumperly:pumperly@localhost:5433/pumperly`. Choose a real password for anything reachable from a network.

## Map defaults

Feature page: [Countries and scrape schedule](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/#default-country-and-fuel>).

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PUMPERLY_DEFAULT_COUNTRY` | `ES` | `src/lib/config.ts` | Country whose centre and zoom the map opens on. Must be an upper-case code from the [country table](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/#default-country-and-fuel>). An unknown code, or a lower-case one, opens on Spain. It is also the source of the default fuel. |
| `PUMPERLY_DEFAULT_FUEL` | the default country's fuel, such as `B7` for Spain | `src/lib/config.ts` | Fuel selected when the map opens. Use a code from [Fuel types](<https://geiserx.github.io/Pumperly/reference/fuel-types/index.md>), for example `E10` or `EV`. The value is not checked. A `fuel` parameter in a [share link](<https://geiserx.github.io/Pumperly/using/links/index.md>) wins over it. |
| `PUMPERLY_CLUSTER_STATIONS` | `true` | `src/lib/config.ts` | Groups nearby stations into clusters at low zoom. Only `true`, in any case, turns it on. Any other value turns it off. Clustering is always off while a route is shown. |

## Countries and scheduling

Feature page: [Countries and scrape schedule](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/index.md>).

A scraper key names one scheduled scraper. Most are a country code (`ES`). The others are `AU_NSW`, `EV_<CC>` for Open Charge Map, `EV_ES_REVE`, `EV_DE_BNETZA`, `EV_DE_OCPDB` and `STATIC_<SOURCE>`. [Scraper keys](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/#scraper-keys>) lists them.

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PUMPERLY_ENABLED_COUNTRIES` | unset, meaning every scraper | `src/instrumentation-node.ts`, `src/lib/config.ts` | Comma-separated scraper keys. Case and spaces do not matter. A plain country code also enables that country's `EV_` scraper. Unknown codes are ignored without a warning. An empty value means unset. A value where nothing matches schedules nothing. [Choosing countries](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/#choosing-countries>) has the full rules. |
| `PUMPERLY_SCRAPE_INTERVAL_HOURS` | unset, meaning each scraper's own default | `src/instrumentation-node.ts` | Hours between runs, for every scraper at once. Decimals work. `0` turns off all automatic scraping, including scrapers that have their own override. A negative value or one that is not a number means the defaults. Above about 596 hours the timer breaks and scrapers run back to back. |
| `PUMPERLY_SCRAPE_INTERVAL_<KEY>` | the scraper's default, see [How often scrapers run](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/#how-often-scrapers-run>) | `src/instrumentation-node.ts` | Hours between runs for one scraper key, for example `PUMPERLY_SCRAPE_INTERVAL_FR=0.5` or `PUMPERLY_SCRAPE_INTERVAL_EV_ES_REVE=1`. Beats the global interval. `0` or a negative value turns that scraper off. The value must be a number between 0 and about 596. An empty value or one that is not a number is not caught: the scraper then runs back to back and fills the log with skip warnings. |

## Price validation

Feature page: [How scrapers work](<https://geiserx.github.io/Pumperly/data/how-scrapers-work/index.md>).

Every scraper run drops prices that cannot be real before it writes anything. A price of zero or less is always dropped. Hydrogen, CNG, LNG and AdBlue prices must be at least 0.05 and below 100, in any currency. EV prices are per kWh and must be in EUR, from 0.10 to 2.00. None of these ranges can be changed.

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PUMPERLY_PRICE_MIN` | `0.30` | `src/scrapers/base.ts` | Lowest accepted price per litre for prices in EUR, GBP and CHF. A value that is not a number means the default. |
| `PUMPERLY_PRICE_MAX` | `4.00` | `src/scrapers/base.ts` | Highest accepted price per litre for prices in EUR, GBP and CHF. A value that is not a number means the default. |

Prices in every other currency are checked against a fixed band per currency, such as 200 to 2,000 for HUF. A currency with no band of its own gets a wide default of 0.1 to 100,000. The bands live in `PRICE_BANDS` in [`src/scrapers/base.ts`](<https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/base.ts>) and have no variable. See [Currencies and exchange rates](<https://geiserx.github.io/Pumperly/reference/currencies/index.md>).

> [!NOTE]
>
> **The comment in `.env.example` is out of date**
>
> `.env.example` says other currencies use 25 times the maximum. The code uses the fixed per-currency bands described above.

## Routing

Feature page: [Routing with Valhalla](<https://geiserx.github.io/Pumperly/configuration/routing-valhalla/index.md>).

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `VALHALLA_URL` | unset | `src/lib/valhalla.ts` | Base URL of a Valhalla server, without a trailing slash, for example `http://pumperly-valhalla:8002`. Pumperly appends `/route`. Unset turns route planning off: `/api/route` answers 502 and no detour times are computed. |
| `VALHALLA_MAX_INFLIGHT` | `6` | `src/lib/valhalla.ts` | Most Valhalla requests the app runs at the same time, across all visitors. Further requests wait in a queue. Must be a whole number of 1 or more. `0`, an empty value or one that is not a number leaves no slot at all, so routing requests queue and never reach Valhalla. |
| `PUMPERLY_MAX_DETOUR_STATIONS` | `150` | `src/app/api/route-detour/route.ts` | Most stations one detour request may route. Extra stations are thinned out evenly along the route. The request itself is limited to 150 stations, so this setting can only lower the cap. A value below 1 or not a number means the default. |

## Geocoding

Feature page: [Geocoding with Photon](<https://geiserx.github.io/Pumperly/configuration/geocoding-photon/index.md>).

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PHOTON_URL` | unset | `src/lib/photon.ts` | Base URL of a Photon server, without a trailing slash, for example `http://pumperly-photon:2322`. Pumperly calls `/api` on it. Unset makes `/api/geocode` return an empty list, so the search boxes find nothing. |

## EV charging

Feature pages: [EV charging sources](<https://geiserx.github.io/Pumperly/data/ev-sources/index.md>) and [API keys](<https://geiserx.github.io/Pumperly/configuration/api-keys/index.md>).

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PUMPERLY_EV_ENABLED` | on | `src/instrumentation-node.ts` | Only the exact value `0` turns off every EV charger scraper, including REVE, BNetzA and OCPDB. Any other value leaves them on. It does not depend on whether an Open Charge Map key is set. |
| `PUMPERLY_DE_EV_SOURCE` | `ocpdb` | `src/scrapers/germany-ev-source.ts` | Which source supplies German chargers, in any case: `ocpdb` for the Open ChargePoint Database, with prices; `bnetza` for the BNetzA Ladesäulenregister; `ocm` for Open Charge Map. Anything else picks OCPDB. Only one ever runs. |
| `PUMPERLY_BNETZA_MIN_STATIONS` | `10000` | `src/scrapers/bnetza.ts` | Stations a BNetzA run must refresh before it deletes chargers that left the register and retires the Open Charge Map and OCPDB German rows. A safety floor: a damaged download cannot empty the map. A value below 1 or not a number means the default. |
| `PUMPERLY_OCPDB_MIN_STATIONS` | `10000` | `src/scrapers/ocpdb.ts` | Stations an OCPDB run must refresh before it deletes chargers that left the database and retires the Open Charge Map and BNetzA German rows. Same safety floor as BNetzA's. A value below 1 or not a number means the default. |
| `PUMPERLY_OCPDB_MAX_FEED_AGE_DAYS` | `3` | `src/scrapers/ocpdb.ts` | Days an OCPDB operator feed may go without refreshing before its tariffs are ignored, so its chargers show unpriced instead of with old prices. Feeds OCPDB marks as failed are always ignored. A value of 0 or less, or not a number, means the default. |
| `PUMPERLY_REVE_PAGES_PER_RUN` | `4` | `src/scrapers/reve.ts` | Pages of 100 locations each REVE run fetches. Values above 5 are lowered to 5, the API's hourly limit. A value below 1 or not a number means the default. |
| `PUMPERLY_REVE_CUTOVER_RATIO` | `0.95` | `src/scrapers/reve.ts` | Share of the REVE registry that must be stored before Open Charge Map's Spanish rows are deleted. Must be above 0 and at most 1. Anything else means the default. |

## API keys

Feature page: [API keys](<https://geiserx.github.io/Pumperly/configuration/api-keys/index.md>). Every key is optional. Without it, the source it unlocks is skipped or fails, and the rest of Pumperly keeps working.

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `TANKERKOENIG_API_KEY` | unset | `src/scrapers/germany.ts` | Germany's fuel prices from Tankerkönig. Without it every German fuel run fails and the last prices stay. |
| `FUELPRICES_DK_API_KEY` | unset | `src/scrapers/denmark.ts` | Denmark's fuel prices from fuelprices.dk. Without it the scraper tries a fallback feed that no longer answers. |
| `PUMPERLY_OCM_API_KEY` | unset | `src/scrapers/ocm.ts` | Open Charge Map, the EV source for every country without an official registry. Without it every `EV_<CC>` run logs `PUMPERLY_OCM_API_KEY not set, skipping` and writes nothing. |
| `PUMPERLY_REVE_API_KEY` | unset | `src/scrapers/reve.ts`, `src/scrapers/spain-ev-source.ts` | Mapa REVE, Spain's official charger registry. When set, Spain's chargers come from REVE instead of Open Charge Map. |
| `NSW_FUEL_API_KEY` | unset | `src/scrapers/australia-nsw.ts` | New South Wales FuelCheck, together with `NSW_FUEL_API_SECRET`. Without both, the `AU_NSW` scraper fails and only Western Australia updates. |
| `NSW_FUEL_API_SECRET` | unset | `src/scrapers/australia-nsw.ts` | The secret that goes with `NSW_FUEL_API_KEY`. |

## Open Charge Map tuning

Open Charge Map cuts every response at 5,000 results. For a large country the scraper splits the map into smaller boxes and asks again. These variables bound that work. The defaults suit the free API. Change them only if your logs show rate limiting or partial coverage.

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `PUMPERLY_OCM_MAX_REQUESTS` | `800` | `src/scrapers/ocm.ts` | Most requests one country may make in one run. Each country also stops after 15 minutes of active fetching. When either limit is reached the run keeps what it has and logs `coverage may be partial`. A value of 0 or less, or not a number, means the default. |
| `PUMPERLY_OCM_TILE_DELAY_MS` | `600` | `src/scrapers/ocm.ts` | Pause between box requests, in milliseconds. A negative value or one that is not a number means the default. `0`, or an empty value, means no pause. Keep it well above 0: Open Charge Map answers bursts with HTTP 429. |
| `PUMPERLY_OCM_MAX_CONCURRENCY` | `1` | `src/scrapers/ocm.ts` | Open Charge Map requests in flight at once, shared by every country. The default runs one request at a time. A value below 1 or not a number means the default. |
| `PUMPERLY_OCM_TRUST_SPAN_DEG` | `2` | `src/scrapers/ocm.ts` | Widest box, in degrees, whose result count the scraper trusts. Open Charge Map under-reports counts for large boxes, so a wider box that returns any result is always split. A value of 0 or less, or not a number, means the default. |

## Set by the runtime

You do not normally set these. The Docker image or Next.js sets them.

| Variable | Value | Read by | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` in the image | `src/lib/db.ts` and Next.js | Outside production, the database client is reused across hot reloads. |
| `NEXT_RUNTIME` | set by Next.js | `src/instrumentation.ts` | The scheduler starts only when this is `nodejs`. |
| `PORT` | `3000` in the image | Next.js server | Port the app listens on inside the container. |
| `HOSTNAME` | `0.0.0.0` in the image | Next.js server | Address the app binds to inside the container. |
| `NEXT_TELEMETRY_DISABLED` | `1` in the image | Next.js | Turns off Next.js telemetry. |

The values come from [`docker/Dockerfile`](<https://github.com/GeiserX/Pumperly/blob/main/docker/Dockerfile>).

## Tests

| Variable | Default | Read by | Notes |
| --- | --- | --- | --- |
| `SKIP_INTEGRATION` | unset | `src/app/api/route-stations/route-stations.integration.test.ts` | `1` skips the integration suite, which starts a PostGIS container through Docker. See [Development](<https://geiserx.github.io/Pumperly/development/index.md>). |

## Helm values

Feature page: [Run on Kubernetes with Helm](<https://geiserx.github.io/Pumperly/getting-started/kubernetes/index.md>).

The chart turns these values into variables. An empty value leaves the variable unset. The chart's schema requires strings, so quote numbers and booleans, for example `scrapeIntervalHours: "6"`.

| Helm value | Chart default | Sets |
| --- | --- | --- |
| `config.defaultCountry` | `"ES"` | [`PUMPERLY_DEFAULT_COUNTRY`](<#pumperly_default_country>) |
| `config.enabledCountries` | `""` | [`PUMPERLY_ENABLED_COUNTRIES`](<#pumperly_enabled_countries>) |
| `config.defaultFuel` | `""` | [`PUMPERLY_DEFAULT_FUEL`](<#pumperly_default_fuel>) |
| `config.clusterStations` | `"true"` | [`PUMPERLY_CLUSTER_STATIONS`](<#pumperly_cluster_stations>) |
| `config.scrapeIntervalHours` | `""` | [`PUMPERLY_SCRAPE_INTERVAL_HOURS`](<#pumperly_scrape_interval_hours>) |
| `config.evEnabled` | `""` | [`PUMPERLY_EV_ENABLED`](<#pumperly_ev_enabled>) |
| `apiKeys.tankerkoenig` | `""` | [`TANKERKOENIG_API_KEY`](<#tankerkoenig_api_key>), stored in the chart's Secret |
| `apiKeys.openChargeMap` | `""` | [`PUMPERLY_OCM_API_KEY`](<#pumperly_ocm_api_key>), stored in the chart's Secret |
| `apiKeys.fuelpricesDk` | `""` | [`FUELPRICES_DK_API_KEY`](<#fuelprices_dk_api_key>), stored in the chart's Secret |
| `postgis.*`, `externalDatabase.*`, `existingSecret` | bundled PostGIS | [`DATABASE_URL`](<#database_url>), read from a Secret |
| `valhalla.enabled`, `externalServices.valhallaUrl` | off | [`VALHALLA_URL`](<#valhalla_url>). With `valhalla.enabled`, it points at the chart's own Valhalla service on port 8002. |
| `photon.enabled`, `externalServices.photonUrl` | off | [`PHOTON_URL`](<#photon_url>). With `photon.enabled`, it points at the chart's own Photon service on port 2322. |
| `extraEnv`, `extraEnvFrom` | empty | Any other variable on this page |

Every variable without a chart value of its own, such as `PUMPERLY_REVE_API_KEY` or a per-scraper interval, goes in `extraEnv`:

values.yaml

```
extraEnv:
  - name: PUMPERLY_SCRAPE_INTERVAL_FR
    value: "0.5"
  - name: PUMPERLY_REVE_API_KEY
    valueFrom:
      secretKeyRef:
        name: pumperly-extra-keys
        key: reve
```

## The shipped example file

This is `.env.example` as it ships. Where its comments differ from the tables above, the tables describe what the code does.

> [!NOTE]
>
> **`.env.example`**
>
> ```
> # =============================================================================
> # Pumperly — Environment Variables
> # =============================================================================
> # Copy this file to .env and fill in the values.
> # Full documentation: https://geiserx.github.io/Pumperly/
> # =============================================================================
>
> # ---------------------------------------------------------------------------
> # Required
> # ---------------------------------------------------------------------------
>
> # PostGIS connection string
> DATABASE_URL=postgresql://pumperly:pumperly@pumperly-db:5432/pumperly
>
> # ---------------------------------------------------------------------------
> # App Configuration
> # ---------------------------------------------------------------------------
>
> # ISO 3166-1 alpha-2 code for initial map view (default: ES)
> PUMPERLY_DEFAULT_COUNTRY=ES
>
> # Comma-separated ISO codes to enable (default: all countries with scrapers)
> # Supported: ES,FR,DE,IT,GB,AT,PT,SI,NL,BE,LU,RO,GR,IE,HR,CH,PL,CZ,HU,BG,SK,DK,SE,NO,RS,FI,EE,LV,LT,BA,MK,TR,MD,IS,CY,TW,AU,AR,MX
> # PUMPERLY_ENABLED_COUNTRIES=ES,FR,PT,IT,AT,DE,GB,SI,NL,BE,LU,RO,GR,IE,HR,CH,PL,CZ,HU,BG,SK,DK,SE,NO,RS,FI,EE,LV,LT,BA,MK,TR,MD,IS,CY,TW,AU,AR,MX,US
> # US is EV-charger-only (no national fuel-price API): "US" enables the EV_US scraper
>
> # Override default fuel type (default: per-country, e.g. B7 for Spain)
> # Valid codes: E5, E10, E5_98, E98_E10, E5_PREMIUM, B7, B7_PREMIUM, B_AGRICULTURAL, HVO, LPG, CNG, LNG, H2, ADBLUE, EV
> # PUMPERLY_DEFAULT_FUEL=B7
>
> # Enable station clustering at low zoom levels (default: true)
> # PUMPERLY_CLUSTER_STATIONS=true
>
> # Price sanity bounds for scraper validation (EUR/GBP/CHF per litre)
> # Prices outside this range are rejected as bad data. Other currencies use 25x max.
> # PUMPERLY_PRICE_MIN=0.30
> # PUMPERLY_PRICE_MAX=4.00
>
> # ---------------------------------------------------------------------------
> # Scraper Schedule
> # ---------------------------------------------------------------------------
>
> # Global scraping interval in hours (default: per-country, see src/instrumentation-node.ts)
> # Runs once on startup + repeats on this interval. Set to 0 to disable all scraping.
> # PUMPERLY_SCRAPE_INTERVAL_HOURS=24
>
> # Per-country overrides (hours), e.g.:
> # PUMPERLY_SCRAPE_INTERVAL_FR=0.5
> # PUMPERLY_SCRAPE_INTERVAL_DE=1
>
> # ---------------------------------------------------------------------------
> # External Services (optional — features degrade gracefully without them)
> # ---------------------------------------------------------------------------
>
> # Valhalla routing engine (enables route planning)
> # VALHALLA_URL=http://pumperly-valhalla:8002
>
> # Photon geocoding (enables address autocomplete)
> # PHOTON_URL=http://pumperly-photon:2322
>
> # ---------------------------------------------------------------------------
> # API Keys (only needed for specific country scrapers)
> # ---------------------------------------------------------------------------
>
> # Germany (Tankerkoenig) — free key from https://creativecommons.tankerkoenig.de
> # TANKERKOENIG_API_KEY=
>
> # OpenChargeMap — EV charging data, free key from https://openchargemap.org
> # PUMPERLY_OCM_API_KEY=
>
> # Spain EV chargers (Mapa REVE) — the official registry every Spanish charge
> # point operator must file into. Free key, request it at
> # https://www.mapareve.es/api-contacto (keys expire after ~1 year).
> # When set, Spain's EV data comes from REVE instead of OpenChargeMap. The
> # existing OpenChargeMap rows for Spain stay put during the backfill (so the
> # map is never empty) and are deleted once REVE reaches 95% of the registry.
> # Note: the API allows only 5 requests/hour of 100 locations each, so the
> # first full load of ~14.5k chargers takes about 37 hours at the default 4
> # pages per run (~30 hours if you raise it to 5). It fills in the background
> # — nothing to do but wait, and expect duplicate Spanish pins until it lands.
> # PUMPERLY_REVE_API_KEY=
>
> # Pages fetched per hourly run (default 4). Values above 5 are clamped to 5,
> # the API's published hourly limit.
> # PUMPERLY_REVE_PAGES_PER_RUN=4
>
> # Denmark (FuelPrices.dk)
> # FUELPRICES_DK_API_KEY=
>
> # Set to 0 to disable EV charger scraping (default: enabled when OCM key is set)
> # PUMPERLY_EV_ENABLED=1
>
> # Germany EV chargers: which source supplies them. Defaults to "ocpdb", the Open
> # ChargePoint Database via MobiData BW: the BNetzA register merged with the
> # operators' own feeds, plus ad-hoc €/kWh prices. No API key, no signup.
> # "bnetza" uses the BNetzA Ladesäulenregister alone (no prices), "ocm" keeps
> # OpenChargeMap. Only one ever runs. ocpdb and bnetza retire the other
> # sources' German rows on their first healthy run; ocm does not, so switching
> # to it leaves the `ocpdb-`/`bnetza-` rows behind to delete by hand.
> # PUMPERLY_DE_EV_SOURCE=ocpdb
>
> # Stations a run must refresh before the OCPDB scraper is allowed to prune
> # stale rows or retire the BNetzA/OpenChargeMap German ones.
> # PUMPERLY_OCPDB_MIN_STATIONS=10000
>
> # Days an OCPDB operator feed may go without refreshing before its prices are
> # ignored (its chargers then show unpriced). Failed feeds are always ignored.
> # PUMPERLY_OCPDB_MAX_FEED_AGE_DAYS=3
>
> # Stations a run must refresh before the BNetzA scraper is allowed to prune
> # stale rows or retire OpenChargeMap's German ones. A safety floor: a degraded
> # fetch must not be able to delete a working map.
> # PUMPERLY_BNETZA_MIN_STATIONS=10000
> ```
