# Run with Docker Compose

This page takes you from an empty Docker host to a Pumperly map in your browser. It covers PostGIS, the database schema and the app. Routing and address search are optional and have their own pages.

## Before you start

You need:

- A Linux or macOS host with Docker Engine and Docker Compose v2 (the `docker compose` command).
- An amd64 or arm64 machine. The `drumsergio/pumperly` image ships for both.
- Git, to clone the repository. The compose file and the database migrations live in it.

### How much machine you need

The app and PostGIS alone fit on a small server. As a starting point, the [Helm chart](<https://geiserx.github.io/Pumperly/getting-started/kubernetes/index.md>) gives the app a 1 GiB memory limit and PostGIS a 4 GiB limit with a 5 GiB volume.

Valhalla and Photon are what make a host large. The figures below are approximate, for routing and address search across most of Europe. A single country needs far less.

| Resource | First start (building routing tiles, importing addresses) | Steady state |
| --- | --- | --- |
| RAM | about 24 GB. The Valhalla tile build alone peaks around 15 GB | 6 to 8 GB |
| Disk | about 300 GB | about 100 GB |
| CPU | several cores shorten the tile build | any |

You can start without Valhalla and Photon and add them later. See [Run without routing and address search](<#run-without-routing-and-address-search>).

## What the shipped compose file runs

The repository ships one compose file, [`docker/docker-compose.yml`](<https://github.com/GeiserX/Pumperly/blob/main/docker/docker-compose.yml>). It runs the database, the schema migrations and the app:

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

- `db` is PostGIS: the container is `pumperly-db` and runs the `postgis/postgis:17-3.4` image. The user, password and database are all `pumperly`. It publishes PostgreSQL on port 5433 of the host, so tools on the host can reach it at `localhost:5433`; inside the compose network it stays on port 5432. Data lives in the named volume `pumperly-pgdata`. The healthcheck runs `pg_isready` over TCP every 5 seconds.
- `migrate` runs once per `up` and exits. It applies the SQL migrations under `prisma/migrations` that the database has not recorded yet. See [step 4](<#4-create-the-database-schema>).
- `app` is Pumperly: the container is `pumperly` and runs the `drumsergio/pumperly` image, pinned to a release. It starts only after `migrate` has finished without an error, reads its settings from `.env` at the repository root, and listens on port 3000.

## Set it up

### 1\. Get the files

```
git clone https://github.com/GeiserX/Pumperly.git
cd Pumperly
```

Every command below runs from the repository root.

### 2\. Write your settings

```
cp .env.example .env
```

This is the full file you copied, [`.env.example`](<https://github.com/GeiserX/Pumperly/blob/main/.env.example>):

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

Only `DATABASE_URL` is required. The default value already matches the shipped compose file: user `pumperly`, password `pumperly`, host `pumperly-db`, port 5432. The app reaches the database by its container name on the compose network.

Settings worth deciding now:

- `PUMPERLY_ENABLED_COUNTRIES`. Leave it unset and the app runs every scraper it has, which means dozens of sources. List only the countries you want, for example `PUMPERLY_ENABLED_COUNTRIES=ES,PT`. Each listed country also enables its EV charger scraper, unless `PUMPERLY_EV_ENABLED=0`. See [Countries and scrape schedule](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/index.md>).
- `PUMPERLY_DEFAULT_COUNTRY`. The country the map opens on. The default is `ES`.
- API keys. Most fuel sources need none. Germany's fuel prices need `TANKERKOENIG_API_KEY`. EV chargers from Open Charge Map need `PUMPERLY_OCM_API_KEY`; Germany's official charger registry needs no key and is the default there. See [API keys](<https://geiserx.github.io/Pumperly/configuration/api-keys/index.md>).

Every variable is described in [Environment variables](<https://geiserx.github.io/Pumperly/reference/environment-variables/index.md>).

### 3\. Start Pumperly

```
docker compose -f docker/docker-compose.yml up -d
```

Compose starts PostGIS, waits until it is healthy, runs `migrate`, and starts the app once the schema is in place. Check the three services and follow the app's log:

```
docker compose -f docker/docker-compose.yml ps -a
docker compose -f docker/docker-compose.yml logs -f app
```

`migrate` shows as exited with code 0; the other two are up. The log shows one line per scraper with its interval, then the first scrapes start about 10 seconds after boot, 5 seconds apart. [What happens on first start](<https://geiserx.github.io/Pumperly/getting-started/first-start/index.md>) explains each line and how to tell the scrapes worked.

### 4\. Create the database schema

The `migrate` service does this for you, on the first `up` and on every later one. It runs `node migrate.mjs` from the app image, which carries [`docker/migrate.mjs`](<https://github.com/GeiserX/Pumperly/blob/main/docker/migrate.mjs>) and the migration files of its release, so the service needs no checkout and always applies the migrations that match the image: each folder under [`prisma/migrations`](<https://github.com/GeiserX/Pumperly/tree/main/prisma/migrations>) is applied once, oldest first, in one transaction per migration, and recorded in Prisma's history table, `_prisma_migrations`, with the checksum Prisma uses. A later `npx prisma migrate deploy` therefore sees the same history and applies nothing twice. Read what it did with:

```
docker compose -f docker/docker-compose.yml logs migrate
```

On a database whose schema was built by hand with no history, `migrate` checks that `0_init` is complete (both tables and the `geom` column), records it as applied, the same as `prisma migrate resolve --applied 0_init`, and runs the later migrations, which are written to be safe to run again. It refuses to start, and so does the app, on a partial schema with no history and on a history row Prisma left unfinished; resolve that one with `npx prisma migrate resolve`. If a migration fails, `migrate` exits with an error, prints the failing statement, and the app does not start.

The migrations enable the PostGIS extension and create two tables, `stations` and `fuel_prices`. The `stations` table has a `geom` column that holds each station's position, with two spatial indexes on it. See [Data model](<https://geiserx.github.io/Pumperly/reference/data-model/index.md>).

> [!CAUTION]
>
> **Do not use `prisma db push` to create the schema**
>
> `prisma db push` builds tables from `prisma/schema.prisma`. That file does not declare the `geom` column, because Prisma has no type for it. Every scraper writes `geom` and the map's queries read it, so on a schema made by `db push` every station insert fails.

### 5\. Open the map

Open [http://localhost:3000](<http://localhost:3000>). The app redirects to a language path such as `/en`, chosen from your browser's language, and opens on `PUMPERLY_DEFAULT_COUNTRY`. If you allow location access, the map then moves to where you are.

Stations appear once their country's first scrape finishes. Until then the map is empty. That is expected.

The image is pinned to a release, never `latest`. Docker Hub carries each release as `1.15.1` and as `v1.15.1`; the compose file on `main` names the newest one. The image listens on port 3000 and runs as user id 1001. It needs no volume: all its state is in PostGIS.

### Next

- [What happens on first start](<https://geiserx.github.io/Pumperly/getting-started/first-start/index.md>): the scrape schedule and how to check it.
- [Routing with Valhalla](<https://geiserx.github.io/Pumperly/configuration/routing-valhalla/index.md>) and [Geocoding with Photon](<https://geiserx.github.io/Pumperly/configuration/geocoding-photon/index.md>): add route planning and address search.
- [Backing up the database](<https://geiserx.github.io/Pumperly/operations/backup-and-restore/index.md>): everything Pumperly knows is in `pumperly-pgdata`.

## Run without routing and address search

Valhalla and Photon are optional. `.env.example` leaves `VALHALLA_URL` and `PHOTON_URL` commented out, so a fresh install runs without both.

| Feature | Without Valhalla | Without Photon |
| --- | --- | --- |
| Map, prices and station details | works | works |
| Scraping | works | works |
| Route planning | off. The route API answers 502 `Routing service unavailable` | works, if Valhalla is set |
| Address search box | works, if Photon is set | returns no results |

To turn a feature on, run the service, set its URL in `.env` and run the `up -d` command from step 3 again. When the service runs in the same compose project, use its container name, for example `VALHALLA_URL=http://pumperly-valhalla:8002` and `PHOTON_URL=http://pumperly-photon:2322`. The setup of each service is in [Routing with Valhalla](<https://geiserx.github.io/Pumperly/configuration/routing-valhalla/index.md>) and [Geocoding with Photon](<https://geiserx.github.io/Pumperly/configuration/geocoding-photon/index.md>).

## Change a setting

Edit `.env`, then run the `up -d` command from step 3 again. Compose recreates the app container because its environment changed.

The scrape schedule is read once, when the app starts. A change to `PUMPERLY_ENABLED_COUNTRIES` or to any `PUMPERLY_SCRAPE_INTERVAL_*` variable takes effect on that restart.

## Before you expose it

This section is for an instance other people will reach. Work through it before the app leaves your own machine. A private instance on your laptop needs none of it.

> [!WARNING]
>
> **The database port is open with a known password**
>
> The shipped compose file publishes PostgreSQL on port 5433 of every host interface, with the password `pumperly`. On a host other machines can reach, block that port in the firewall, or change the password before the first start. `POSTGRES_PASSWORD` only takes effect when the volume is first created, and `DATABASE_URL` in `.env` must carry the same password.

The app has no login. Anyone who can reach it can read the map and call the [HTTP API](<https://geiserx.github.io/Pumperly/reference/api/index.md>). It has no way to change data from the browser.

### Checklist

| Item | Why | Where |
| --- | --- | --- |
| Terminate HTTPS at a reverse proxy | The app serves plain HTTP on port 3000. | Your proxy. |
| Replace `X-Forwarded-For` | The routing endpoints (`/api/route`, `/api/route-stations` and `/api/route-detour`) limit requests per client IP. They read the IP from the first `X-Forwarded-For` entry, then from `X-Real-IP`. A proxy that appends to a client-sent value lets the client pick its own IP and dodge the limit. Without a proxy, every client that sends neither header shares one limit. | Your proxy. |
| Compress, except the detour stream | The app does not compress its responses. Compression is off in [`next.config.ts`](<https://github.com/GeiserX/Pumperly/blob/main/next.config.ts>) so that streamed responses reach the browser as they are produced. `/api/route-detour` streams one JSON line per station. A proxy that buffers or compresses it holds every line back until the end. | Your proxy. |
| Add security headers and a CSP | The app sets no security headers and no Content Security Policy. `next.config.ts` has no `headers()` section. | Your proxy. See [Security headers](<#security-headers>). |
| Rate-limit the other endpoints | Only the three routing endpoints have a limit inside the app. `/api/geocode` forwards every request to Photon. `/api/stations` and `/api/stations/nearest` query PostGIS on every request. | Your proxy. See [Rate limits](<#rate-limits>). |
| Keep the database, Valhalla and Photon private | Only the app needs to reach them. | Your firewall and compose networks. |
| Replace the pumperly.com identity | The app names pumperly.com in its search-engine metadata, its legal dialogs and some scraper requests. No setting changes this. | The source files. See [The app still calls itself pumperly.com](<#the-app-still-calls-itself-pumperlycom>). |
| Respect the data licences | Some sources forbid commercial use, and most require credit. | See [Data licences on a public instance](<#data-licences-on-a-public-instance>). |

When the proxy runs on the same host, publish the app on the loopback interface only, so that nothing reaches port 3000 around the proxy. In `docker/docker-compose.yml`, change the app's port line to `"127.0.0.1:3000:3000"`.

### Security headers

A Content Security Policy (CSP) is a response header that tells the browser which origins a page may load code and data from. The app needs these origins:

| What | Origin | CSP directive |
| --- | --- | --- |
| The page, its scripts, styles and the map worker | the app's own origin | `default-src 'self'`, `worker-src 'self'` |
| The theme script inline in the page head, and the inline scripts Next.js adds to hydrate the page | inline | `script-src 'self' 'unsafe-inline'` |
| `style` attributes on some components | inline | `style-src 'self' 'unsafe-inline'` |
| The map style, tiles, fonts and sprites | `https://tiles.openfreemap.org` | `connect-src 'self' https://tiles.openfreemap.org` |
| Map icons MapLibre builds in memory | `data:` and `blob:` URLs | `img-src 'self' data: blob:` |

The map styles are set in [`src/lib/theme.tsx`](<https://github.com/GeiserX/Pumperly/blob/main/src/lib/theme.tsx>). The inline scripts are in [`src/app/layout.tsx`](<https://github.com/GeiserX/Pumperly/blob/main/src/app/layout.tsx>). The MapLibre worker is served from `/maplibre/` on the app's own origin, so it needs no `blob:` worker source.

This policy follows from that list:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

> [!WARNING]
>
> **Test the policy before you enforce it**
>
> Send it first as `Content-Security-Policy-Report-Only`. The browser then reports what it would block without blocking it. Open the map in both themes, search an address and plan a route with the browser console open. Switch the header name to `Content-Security-Policy` once the console shows no CSP reports. If you change the map style in `theme.tsx`, add the new style's origins to `connect-src`.

`frame-ancestors 'none'` stops other sites from showing Pumperly in a frame. Remove it if you embed the map in a page of your own.

Add these headers as well:

| Header | Value |
| --- | --- |
| `Strict-Transport-Security` | `max-age=31536000` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

### Rate limits

The app's own limits cover only route planning: 30 requests a minute per client IP for `/api/route` and `/api/route-stations`, and 10 for `/api/route-detour`. Every other endpoint answers as often as it is asked. [HTTP API](<https://geiserx.github.io/Pumperly/reference/api/#overview>) lists each endpoint and its limit.

Limit these at the proxy:

| Endpoint | What each request costs |
| --- | --- |
| `/api/geocode` | One request to Photon. The search box sends one after each 300 ms pause in typing. |
| `/api/stations` | One PostGIS query. The map sends one after each 100 ms pause while you pan or zoom. |
| `/api/stations/nearest` | One PostGIS query. |
| `/api/stats` | One query that joins every station to every price row. |

The rates in the examples below are starting points. They allow a person panning the map and typing, and stop a script that loops. Watch your proxy's log for rejected requests from real visitors, and raise the rate if you see them.

### Example proxy configurations

Both examples serve `pumperly.example.com` and reach the app on `127.0.0.1:3000`. They set the headers above, replace `X-Forwarded-For`, compress everything except the detour stream, and never buffer it.

nginx has a built-in rate limiter, `limit_req`. Put the two `limit_req_zone` lines in the `http` block.

```
limit_req_zone $binary_remote_addr zone=pumperly_api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=pumperly_geocode:10m rate=5r/s;

server {
    listen 443 ssl;
    server_name pumperly.example.com;
    ssl_certificate     /etc/ssl/pumperly.example.com.crt;
    ssl_certificate_key /etc/ssl/pumperly.example.com.key;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    # Replace, never append: the app trusts the first entry.
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;

    limit_req_status 429;

    location / {
        proxy_pass http://127.0.0.1:3000;
    }

    location /api/ {
        limit_req zone=pumperly_api burst=40 nodelay;
        proxy_pass http://127.0.0.1:3000;
    }

    location = /api/geocode {
        limit_req zone=pumperly_geocode burst=10 nodelay;
        proxy_pass http://127.0.0.1:3000;
    }

    # One JSON line per station, sent as soon as it is ready.
    location = /api/route-detour {
        gzip off;
        proxy_buffering off;
        proxy_pass http://127.0.0.1:3000;
    }
}
```

nginx applies `add_header` and `proxy_set_header` from the `server` block only to locations that set none of their own. Keep them in the `server` block, or repeat all of them in any location that adds one.

Caddy gets and renews the HTTPS certificate itself. Its `reverse_proxy` replaces `X-Forwarded-For` with the client's address, unless you list that client in `trusted_proxies`. Caddy has no built-in rate limiter, so this example sets none. Add a rate-limit module to your Caddy build, or use nginx.

```
pumperly.example.com {
    @compressible not path /api/route-detour
    encode @compressible zstd gzip

    header {
        Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://tiles.openfreemap.org; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

`flush_interval -1` sends each chunk of a response to the browser as soon as it arrives, which keeps the detour stream live.

The detour stream also sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`. nginx reads the first and turns off buffering for that response on its own. The `location` block above makes it explicit.

### The app still calls itself pumperly.com

The app is written for the public instance at pumperly.com. Several files name that site, and no environment variable changes them. A public copy that keeps them tells search engines that pumperly.com is the real address of every page. It also shows visitors the privacy contact of the pumperly.com operator, not yours.

| What | Where it shows | File |
| --- | --- | --- |
| The canonical URL, the `hreflang` alternates for each language, the Open Graph URL and `metadataBase` | The `<head>` of every page. All are `https://pumperly.com/<locale>`. | [`src/app/[locale]/layout.tsx`](<https://github.com/GeiserX/Pumperly/blob/main/src/app/%5Blocale%5D/layout.tsx>) |
| The sitemap | `/sitemap.xml` lists pumperly.com URLs. | [`src/app/sitemap.ts`](<https://github.com/GeiserX/Pumperly/blob/main/src/app/sitemap.ts>) |
| The robots file | `/robots.txt` points at `https://pumperly.com/sitemap.xml`. | [`src/app/robots.ts`](<https://github.com/GeiserX/Pumperly/blob/main/src/app/robots.ts>) |
| The structured data block | A JSON-LD `WebApplication` in every page, with `url` set to pumperly.com. | [`src/app/layout.tsx`](<https://github.com/GeiserX/Pumperly/blob/main/src/app/layout.tsx>) |
| The Privacy, Terms and Data Sources dialogs | They speak as "we" for the pumperly.com operator and give `support@pumperly.com` as the contact. | [`src/components/nav/legal-modal.tsx`](<https://github.com/GeiserX/Pumperly/blob/main/src/components/nav/legal-modal.tsx>) |
| The Support link in the menu | A `mailto:support@pumperly.com` link. | [`src/components/nav/navbar.tsx`](<https://github.com/GeiserX/Pumperly/blob/main/src/components/nav/navbar.tsx>) |
| The scraper `User-Agent` | The Spain fuel scraper and the Mapa REVE and BNetzA charger scrapers send `Pumperly/1.0` with a pumperly.com link, so the source can see who is asking. | [`src/scrapers/spain.ts`](<https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/spain.ts>), [`reve.ts`](<https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/reve.ts>), [`bnetza.ts`](<https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/bnetza.ts>) |

To run a public instance under your own name, change these files and build your own image. Point the URLs at your own domain. Rewrite the Privacy and Terms text so it describes how you run the service, and put your own contact in the dialogs and the menu. Point the scraper `User-Agent` link at a page where a source's operator can reach you. Keep the name `Pumperly/1.0` in it: it identifies the software, and it does not hide who is asking.

> [!NOTE]
>
> **A private instance can ignore this**
>
> An instance that only you and your household use, or one that search engines cannot reach, is not affected by the canonical URL or the sitemap. The scraper `User-Agent` still names pumperly.com.

### Data licences on a public instance

Pumperly's code is AGPL-3.0-or-later. The prices and charger locations it shows are not: each keeps the licence of its source. These terms bind whoever publishes the data, so they bind you when you run a public instance.

| Source | Countries | What the licence asks of you |
| --- | --- | --- |
| [DGEG](<https://geiserx.github.io/Pumperly/data/fuel-sources/#portugal>) | Portugal, fuel | Non-commercial use only. |
| [Mapa REVE](<https://geiserx.github.io/Pumperly/data/ev-sources/#mapa-reve>) | Spain, chargers, only when `PUMPERLY_REVE_API_KEY` is set | Non-commercial use only. Credit Red Eléctrica de España, and do not alter or misrepresent the data. |
| [Consumer Protection Service](<https://geiserx.github.io/Pumperly/data/fuel-sources/#cyprus>) | Cyprus, fuel | CC BY-SA 4.0. Credit the source. Data you derive from it must be shared under the same licence. |
| [Open Charge Map](<https://geiserx.github.io/Pumperly/data/ev-sources/#open-charge-map>) | Chargers in every country that uses it | Open Database License (ODbL). Credit Open Charge Map. A database you derive from it must stay under the ODbL. |
| [BNetzA Ladesäulenregister](<https://geiserx.github.io/Pumperly/data/ev-sources/#bnetza>) | Germany, chargers | CC BY 4.0. Credit "Bundesnetzagentur.de". |
| OpenStreetMap, through the OpenFreeMap tiles and through Valhalla and Photon | The map, routes and address search | ODbL. Credit "© OpenStreetMap contributors". |

Most other sources also ask for credit. [Fuel price sources](<https://geiserx.github.io/Pumperly/data/fuel-sources/index.md>) and [EV charging sources](<https://geiserx.github.io/Pumperly/data/ev-sources/index.md>) give each one's licence where the project records it.

The app gives that credit in its **Data Sources** dialog, opened from the menu. The dialog is in [`src/components/nav/legal-modal.tsx`](<https://github.com/GeiserX/Pumperly/blob/main/src/components/nav/legal-modal.tsx>). Keep it reachable when you change the menu or rewrite the legal text.

> [!WARNING]
>
> **Commercial and ad-funded instances**
>
> An instance that charges users, shows ads or serves a business can count as commercial use. On such an instance, drop the two non-commercial sources:
>
> - Set `PUMPERLY_ENABLED_COUNTRIES` to a list without `PT`. Leaving it unset runs every scraper, Portugal included.
> - Leave `PUMPERLY_REVE_API_KEY` unset. Spain's chargers then come from Open Charge Map instead, when `PUMPERLY_OCM_API_KEY` is set.
>
> Stopping a scraper does not remove what it already wrote, and the map keeps showing it. Delete Portugal's rows with `DELETE FROM stations WHERE country = 'PT';` in `psql`. Their prices go with them. [Switching a source back](<https://geiserx.github.io/Pumperly/data/ev-sources/#switching-back>) gives the statement for Mapa REVE's rows.
>
> Read each remaining source's terms yourself. This page lists what the project records. It is not legal advice.
