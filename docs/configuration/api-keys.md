# API keys

This page lists every API key Pumperly can use: where to get it, what it unlocks, and what happens without it. Most sources need no key at all. Every key is free, and every key is optional.

## Summary {#summary}

| Variable | Source | Unlocks | Without it |
|---|---|---|---|
| [`TANKERKOENIG_API_KEY`](#tankerkonig-germany) | Tankerkönig | Germany's fuel prices | No German fuel prices. Each run fails and the last prices stay. |
| [`FUELPRICES_DK_API_KEY`](#fuelpricesdk-denmark) | fuelprices.dk | Denmark's fuel prices | A fallback feed is tried, and it no longer answers. |
| [`PUMPERLY_OCM_API_KEY`](#open-charge-map) | Open Charge Map | EV chargers in every country without an official registry | No chargers from Open Charge Map. Germany still gets chargers from BNetzA. |
| [`PUMPERLY_REVE_API_KEY`](#mapa-reve-spain) | Mapa REVE | Spain's chargers from the official registry | Spain's chargers come from Open Charge Map instead. |
| [`NSW_FUEL_API_KEY`](#nsw-fuelcheck-australia) and [`NSW_FUEL_API_SECRET`](#nsw-fuelcheck-australia) | NSW FuelCheck | Fuel prices in New South Wales, Australia | Only Western Australia updates. |

Every other source, in every other country, is keyless. That includes Germany's charger registry, the [BNetzA Ladesäulenregister](../data/ev-sources.md). [Fuel price sources](../data/fuel-sources.md) and [EV charging sources](../data/ev-sources.md) list them all.

## Setting a key {#setting-a-key}

=== "Docker Compose"

    Put the key in the `.env` file that the app service reads, then recreate the container:

    ```bash
    TANKERKOENIG_API_KEY=00000000-0000-0000-0000-000000000000
    PUMPERLY_OCM_API_KEY=your-open-charge-map-key
    ```

    ```bash
    docker compose up -d
    ```

    Git ignores `.env`, so the keys stay out of commits. Never put a key in `docker-compose.yml` if you commit that file.

=== "Helm"

    The chart has values for three keys. It stores them in its own Secret:

    ```yaml
    apiKeys:
      tankerkoenig: "00000000-0000-0000-0000-000000000000"
      openChargeMap: "your-open-charge-map-key"
      fuelpricesDk: "your-fuelprices-dk-key"
    ```

    The REVE and NSW keys have no chart value. Keep them in a Secret you manage, and pass them with `extraEnv`:

    ```yaml
    extraEnv:
      - name: PUMPERLY_REVE_API_KEY
        valueFrom:
          secretKeyRef:
            name: pumperly-extra-keys
            key: reve
      - name: NSW_FUEL_API_KEY
        valueFrom:
          secretKeyRef:
            name: pumperly-extra-keys
            key: nsw-key
      - name: NSW_FUEL_API_SECRET
        valueFrom:
          secretKeyRef:
            name: pumperly-extra-keys
            key: nsw-secret
    ```

=== "Source checkout"

    Put the key in `.env` in the repository root. The dev server and the scraper CLI both load it:

    ```bash
    npm run scraper:run -- --country=DE
    ```

Keys are read when the app starts. Restart it after adding or changing one.

## Tankerkönig (Germany) {#tankerkonig-germany}

[Tankerkönig](https://creativecommons.tankerkoenig.de) republishes the prices German stations must report to the Markttransparenzstelle für Kraftstoffe (MTS-K), the Federal Cartel Office's fuel price transparency unit. It covers about 14,700 stations. The data is licensed CC BY 4.0.

- **Get a key:** register at [onboarding.tankerkoenig.de](https://onboarding.tankerkoenig.de).
- **Variable:** [`TANKERKOENIG_API_KEY`](../reference/environment-variables.md#tankerkoenig_api_key).
- **How it is used:** the API searches a radius of at most 25 km. The scraper covers Germany with a grid of 340 overlapping circles, so one run makes 340 requests. The `DE` scraper runs every hour by default. When the API answers `503`, the scraper waits 10 seconds and moves on to the next circle.
- **Without it:** every `DE` run fails before it writes anything, and the last German prices stay on the map. The log shows:

    ```text
    [tankerkoenig] Fatal error: TANKERKOENIG_API_KEY env var required. Register at https://onboarding.tankerkoenig.de
    ```

## fuelprices.dk (Denmark) {#fuelpricesdk-denmark}

[fuelprices.dk](https://fuelprices.dk) aggregates Danish station prices from the fuel companies, such as Circle K, Shell, OK and Q8. Prices are in Danish kroner.

- **Get a key:** register at [fuelprices.dk/registrer](https://fuelprices.dk/registrer).
- **Variable:** [`FUELPRICES_DK_API_KEY`](../reference/environment-variables.md#fuelprices_dk_api_key).
- **How it is used:** one request per run, sent with the key in the `X-API-KEY` header. It returns every station in Denmark with its current prices. The `DK` scraper runs every 6 hours by default.
- **Without it, or with a rejected key:** the scraper falls back to the DrivstoffAppen feed, the same one the Norway scraper uses. That feed no longer answers public requests, so in practice Denmark needs the key. The log shows one of:

    ```text
    [fuelprices_dk] No FUELPRICES_DK_API_KEY — falling back to DrivstoffAppen API
    [fuelprices_dk] API key rejected (401). Register at https://fuelprices.dk/registrer
    ```

## Open Charge Map {#open-charge-map}

[Open Charge Map](https://openchargemap.org) is a community-maintained registry of EV chargers worldwide. It is licensed under the Open Database License (ODbL). Pumperly uses it in every country that has no official registry, and in the United States.

- **Get a key:** create a free account at [openchargemap.org](https://openchargemap.org) and create an API key there.
- **Variable:** [`PUMPERLY_OCM_API_KEY`](../reference/environment-variables.md#pumperly_ocm_api_key).
- **How it is used:** the key goes in the `X-API-Key` header. Each `EV_<CC>` scraper runs once a day by default. A small country takes one request. The API returns at most 5,000 chargers per request, so for a large country the scraper splits the map into smaller boxes. By default it sends one request at a time across all countries, with 600 ms between requests, and at most 800 requests per country per run. [Open Charge Map tuning](../reference/environment-variables.md#open-charge-map-tuning) lists the settings.
- **Without it:** every Open Charge Map scraper skips its run and writes nothing. Chargers already in the database stay. Germany still gets chargers from the keyless BNetzA register, and Spain from REVE if you set that key. The log shows, for each country:

    ```text
    [ocm] PUMPERLY_OCM_API_KEY not set, skipping
    ```

## Mapa REVE (Spain) {#mapa-reve-spain}

[Mapa REVE](https://www.mapareve.es) is Spain's official registry of public charge points, run by Red Eléctrica de España. Every Spanish charge point operator must report to it, so it is authoritative where Open Charge Map is crowdsourced. It holds about 14,500 locations. The data may be used for non-commercial purposes only, and Red Eléctrica must be credited. Pumperly's legal notice does that.

- **Get a key:** request one at [mapareve.es/api-contacto](https://www.mapareve.es/api-contacto). Keys expire after about a year, so note the date and request a new one in time.
- **Variable:** [`PUMPERLY_REVE_API_KEY`](../reference/environment-variables.md#pumperly_reve_api_key). Two tuning settings go with it: [`PUMPERLY_REVE_PAGES_PER_RUN`](../reference/environment-variables.md#pumperly_reve_pages_per_run) and [`PUMPERLY_REVE_CUTOVER_RATIO`](../reference/environment-variables.md#pumperly_reve_cutover_ratio).
- **Without it:** Spain's chargers come from Open Charge Map, as for every other country.

### What happens when you set the key {#what-happens-when-you-set-the-key}

The API allows 5 requests an hour, with 100 locations per request. A full copy of the registry cannot be fetched in one go, so Pumperly fills it in over many hours:

1. On the next start, the scheduler replaces Open Charge Map's Spanish scraper with REVE's. Open Charge Map's Spanish chargers stay on the map for now.
2. The REVE scraper runs every hour. Each run fetches the next 4 pages, 400 locations. Which pages is worked out from the clock, so a restart does not lose its place.
3. The first full pass takes about 37 hours at 4 pages a run. At 5 pages, the most the limit allows, it takes about 30 hours. After that, the runs keep cycling through the registry, which keeps it fresh.
4. The run that brings REVE to 95% of the registry also deletes Open Charge Map's Spanish chargers.

Until step 4, many Spanish chargers show two pins, one from each source. That is expected, and it clears on its own. The log tracks the progress:

```text
[scraper] Spain EV: using Mapa REVE (official registry) instead of OpenChargeMap
[reve] backfill 4000/14500 — keeping 13000 OpenChargeMap row(s) until 13775
[reve] backfill complete (13800/14500) — retired 13000 superseded OpenChargeMap row(s) for ES
```

The numbers above are examples.

!!! note "Leave one request an hour spare"
    The default of 4 pages a run leaves one request each hour for a manual `npm run scraper:run -- --country=EV_ES_REVE` or a quick test. When the API answers `429`, the run keeps what it has fetched and the next hourly run carries on.

!!! warning "Keep REVE hourly"
    `PUMPERLY_SCRAPE_INTERVAL_HOURS` changes REVE's interval too. [Countries and scrape schedule](countries-and-schedule.md#changing-intervals) explains why REVE must stay hourly and how to pin it.

If you later remove the key, Spain goes back to Open Charge Map, and the REVE chargers stay in the database. See [Switching back leaves the registry's rows behind](countries-and-schedule.md#spain-and-germany-ev-sources) to remove them.

## NSW FuelCheck (Australia) {#nsw-fuelcheck-australia}

FuelCheck is the New South Wales Government's fuel price service. It covers about 3,200 stations, with prices in Australian cents per litre. The `AU` scraper covers Western Australia through FuelWatch, which needs no key. New South Wales is a separate scraper, `AU_NSW`.

- **Get a key:** register an app for the Fuel API on the NSW Government's API portal. It gives you an API key and an API secret. The free tier allows 2,500 calls a month. Pumperly uses 2 calls per run, and runs `AU_NSW` every 12 hours by default, so it stays far below that.
- **Variables:** [`NSW_FUEL_API_KEY`](../reference/environment-variables.md#nsw_fuel_api_key) and [`NSW_FUEL_API_SECRET`](../reference/environment-variables.md#nsw_fuel_api_secret). Both are required.
- **How it is used:** each run first trades the key and secret for an access token, then downloads all stations and prices in one request.
- **Without them:** every `AU_NSW` run fails, and Western Australia keeps updating. The log shows:

    ```text
    [nsw_fuelcheck] Fatal error: NSW_FUEL_API_KEY and NSW_FUEL_API_SECRET must be set
    ```

!!! warning "`AU` alone does not include New South Wales"
    If you set `PUMPERLY_ENABLED_COUNTRIES`, list `AU_NSW` as well as `AU`. When the variable is unset, both run. See [Choosing countries](countries-and-schedule.md#choosing-countries).

## Checking that a key works {#checking-that-a-key-works}

Each scraper run ends with one summary line in the app log:

```text
[scraper] DE: OK — 14700 stations, 41000 prices in 95.2s
[scraper] DE: 1 error(s) — 0 stations, 0 prices in 0.1s
```

`OK` means the run finished without errors. An error count means something failed. The lines directly above it, tagged with the source name, say what. The scrapers start one after another in the first minutes after boot, so give them a few minutes. To follow the log:

```bash
docker logs -f pumperly 2>&1 | grep -E '\[(scraper|tankerkoenig|fuelprices_dk|ocm|reve|nsw_fuelcheck)\]'
```

Replace `pumperly` with the name of your app container. The station and price counts above are examples.
