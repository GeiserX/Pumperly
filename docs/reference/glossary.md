# Glossary

This page defines the terms used across the Pumperly documentation. Each entry is short and links to the page that covers the term in depth.

## Alternate route {#alternate-route}

A second or third way to drive between the same two points. For a plain trip from A to B, Pumperly asks [Valhalla](#valhalla) for up to 2 alternates and shows them next to the main route. A trip with [waypoints](#waypoint) gets one route only. See [`POST /api/route`](api.md#route).

## Bounding box (bbox) {#bbox}

A rectangle on the map, given as four numbers: `minLon,minLat,maxLon,maxLat`. The map sends the visible area as a bounding box to [`/api/stations`](api.md#stations).

## BNetzA {#bnetza}

The Bundesnetzagentur, Germany's federal network agency. It publishes the Ladesäulenregister, the official register of public charge points in Germany. Every operator of a public charge point must file its chargers there. Pumperly downloads the register as one file, with no API key, and uses it as Germany's default EV source. Its [scraper key](#scraper-key) is `EV_DE_BNETZA`. See [EV charging sources](../data/ev-sources.md).

## Corridor {#corridor}

The strip of land either side of a planned route in which Pumperly looks for stations. Its half-width is set in kilometres, from 0.5 to 50, and defaults to 5. A station is in the corridor when its shortest distance to the route line, measured on the globe, is within that width. The corridor slider in the route panel changes it. See [Planning a route](../using/routes.md) and [`POST /api/route-stations`](api.md#route-stations).

## Currency {#currency}

Each stored price carries the ISO 4217 code of the currency its [source](#source) publishes it in, such as `EUR` or `HUF`. Pumperly stores prices unconverted. The browser converts them for display. See [Currencies and exchange rates](currencies.md).

## Detour {#detour}

The extra driving time, in minutes, that stopping at a station adds to a trip. Pumperly computes it with [Valhalla](#valhalla) in one of two ways:

- **Route-relative:** the time to drive from a point on the route before the station, through the station, to a point after it, minus the time the route itself takes between those two points. This measures the detour from the route you are on.
- **Whole trip:** the time from origin through the station to destination, minus the original route's time. This measures the best detour over any route.

See [`POST /api/route-detour`](api.md#route-detour).

## ECB reference rates {#ecb}

The daily euro exchange rates published by the European Central Bank. Pumperly uses them to convert prices between currencies, with fixed [fallback rates](currencies.md#fallback-rates) for a few currencies the ECB does not publish. See [The ECB feed](currencies.md#the-ecb-feed).

## Empty-fetch guard {#empty-fetch-guard}

A safety check in every [scraper](#scraper) run. If a fetch returns no stations to store, the run stops before it deletes or replaces anything. A source that answers with an empty or broken file therefore cannot wipe a country off the map. See [How scrapers work](../data/how-scrapers-work.md).

## Enabled countries {#enabled-countries}

The countries an instance scrapes. They come from [`PUMPERLY_ENABLED_COUNTRIES`](environment-variables.md#pumperly_enabled_countries), a comma-separated list of country codes or [scraper keys](#scraper-key). When it is unset, every country with a scraper is enabled. Enabling a country also enables its [EV_XX key](#ev-xx-key). Disabling a country stops its scrapers. It does not delete the rows already stored. See [Countries and scrape schedule](../configuration/countries-and-schedule.md).

## EV_XX key {#ev-xx-key}

The [scraper key](#scraper-key) for a country's EV chargers from [OpenChargeMap](#ocm), where `XX` is the country code: `EV_FR`, `EV_IT` and so on. Listing `FR` in the [enabled countries](#enabled-countries) turns on `EV_FR` too, unless [`PUMPERLY_EV_ENABLED`](environment-variables.md#pumperly_ev_enabled) is `0`. `EV_US` exists without a matching fuel scraper, so listing `US` gives EV chargers only. Spain and Germany each have a second EV key, `EV_ES_REVE` and `EV_DE_BNETZA`, and only one of each pair ever runs. See [handover](#handover).

## External ID {#external-id}

A station's identifier at its [source](#source). Together with the country code it is the key a scraper writes on: a re-import updates the same row instead of adding a new one, and share links use this pair. For [BNetzA](#bnetza) chargers the ID is built from the coordinates, so it changes when an operator corrects a position. Some sources get a prefix, such as `ocm-` for [OpenChargeMap](#ocm) and `reve-` for [REVE](#reve). The database's own UUID can change, so do not store it. See [Data model](data-model.md).

## Fuel code {#fuel-code}

The short code Pumperly uses for a fuel, such as `B7` for diesel or `E10` for petrol with up to 10% ethanol. The core codes, such as `E5`, `E10` and `B7`, follow the European standard EN 16942. `EV` is a code too, for charge points. See [Fuel types](fuel-types.md).

## Fuelo.net {#fuelo}

A community-sourced fuel price site that covers many countries in Europe and nearby. One shared Pumperly scraper reads it for twelve countries, among them Switzerland, Poland and the Czech Republic. Fuelo.net currently refuses those requests, so these countries are paused. See [Fuel price sources](../data/fuel-sources.md#fuelo) and [Coverage and status](../data/coverage.md).

## GeoJSON {#geojson}

A standard JSON format for map data. Pumperly returns stations as a GeoJSON `FeatureCollection` of `Point` features, and routes as `LineString` geometries. Coordinates are always `[longitude, latitude]`.

## Handover {#handover}

The switch from one [source](#source) to another for the same data, done without leaving the map empty in between. For Spain, [REVE](#reve) takes over EV chargers from [OpenChargeMap](#ocm) once a REVE key is set. REVE fills in slowly, over about a day and a half, so the OpenChargeMap rows stay until REVE holds 95% of its registry by default, and are deleted then. For Germany, [BNetzA](#bnetza) takes over after its first healthy run, because the register arrives complete in one file. That run must refresh a minimum number of stations before it may delete anything, so a broken download cannot remove working rows. Sweden's fuel scraper uses the same kind of floor when it retires the rows of an older source. See [EV charging sources](../data/ev-sources.md).

## Latest price {#latest-price}

The price Pumperly shows for a station and fuel: the stored price with the newest `reported_at` time. `reported_at` is when Pumperly's scraper stored the price, not when the source published it.

## NDJSON {#ndjson}

Newline-delimited JSON: one complete JSON object per line. [`POST /api/route-detour`](api.md#route-detour) streams its results in this format, so each station's detour appears as soon as it is known.

## OCM (OpenChargeMap) {#ocm}

[OpenChargeMap](https://openchargemap.org), a crowdsourced, worldwide registry of EV charge points, published under the Open Database License. It is Pumperly's default EV source for every country except Germany. It needs a free API key in [`PUMPERLY_OCM_API_KEY`](environment-variables.md#pumperly_ocm_api_key). Without one, the OpenChargeMap scrapers fetch nothing. See [EV charging sources](../data/ev-sources.md) and [API keys](../configuration/api-keys.md).

## Orphan cleanup {#orphan-cleanup}

The last step of a scraper run. It deletes the country's fuel stations that no longer have a price from any source. EV chargers are never removed this way, because they have no prices. If any batch of station writes failed in the run, the cleanup is skipped. That stops it from deleting stations whose update never landed.

## Photon {#photon}

An open-source geocoder built on OpenStreetMap data. A geocoder turns a place name into coordinates. Pumperly calls Photon for the search box on the map, through [`/api/geocode`](api.md#geocode). Without [`PHOTON_URL`](environment-variables.md#photon_url) the search returns no results. See [Geocoding with Photon](../configuration/geocoding-photon.md).

## PostGIS {#postgis}

The spatial extension for PostgreSQL. It stores each station's position as a point and answers location questions such as "which stations are inside this box" or "which are within 5 km of this line". Pumperly needs a PostgreSQL database with PostGIS enabled. See [Data model](data-model.md).

## Price band {#price-band}

The range of prices Pumperly accepts for a currency, such as 200 to 2,000 for Hungarian forints. A scraper drops any price outside its band before storing it. That catches placeholders and prices in the wrong unit. See [Price bands](currencies.md#price-bands).

## Rate limit {#rate-limit}

A cap on how many requests one client IP may send to an endpoint per minute. It applies to the three route endpoints only. Going over it returns `429 Too many requests`. See [Rate limits](api.md#rate-limits).

## REVE (Mapa REVE) {#reve}

Spain's official registry of EV charge points, run by Red Eléctrica de España. Every Spanish charge point operator must file into it. Pumperly uses it for Spain's chargers when [`PUMPERLY_REVE_API_KEY`](environment-variables.md#pumperly_reve_api_key) is set. Its API allows only 5 requests an hour, so the first full load takes more than a day. Its [scraper key](#scraper-key) is `EV_ES_REVE`. See [EV charging sources](../data/ev-sources.md).

## Route fraction {#route-fraction}

A station's position along a route, from `0` at the start to `1` at the end. [`POST /api/route-stations`](api.md#route-stations) returns stations sorted by it.

## Scrape interval {#scrape-interval}

How often, in hours, a [scraper](#scraper) runs. Each scraper has a default, from 1 hour to 24. Every scraper also runs once shortly after the app starts. `PUMPERLY_SCRAPE_INTERVAL_HOURS` sets one interval for all, and `PUMPERLY_SCRAPE_INTERVAL_<KEY>` sets one [scraper key](#scraper-key)'s. See [Countries and scrape schedule](../configuration/countries-and-schedule.md).

## Scraper {#scraper}

The code that downloads one [source's](#source) data, turns it into Pumperly's stations and prices, and stores it. Each one handles one country, or one country's EV chargers. Scrapers run inside the app on a timer. See [How scrapers work](../data/how-scrapers-work.md).

## Scraper key {#scraper-key}

The name a scraper is scheduled and configured under. Fuel scrapers use the country code, such as `ES`. EV scrapers use an [EV_XX key](#ev-xx-key). A few have their own names: `AU_NSW` for New South Wales, `EV_ES_REVE`, `EV_DE_BNETZA`, and `STATIC_<SOURCE>` for each [static dataset](#static-dataset). The per-scraper interval variable uses the same key, as in `PUMPERLY_SCRAPE_INTERVAL_EV_ES_REVE`.

## Source {#source}

The place a scraper gets its data from: a government feed, a commercial API or a community site. Each price row stores its source name, such as `miteco` for Spain's ministry or `anwb` for the Netherlands, Belgium and Luxembourg. EV sources store no prices. A scraper run replaces only the prices of its own source in its own country, so sources never overwrite each other. See [Data sources](../data/coverage.md).

## Static dataset {#static-dataset}

Station data committed to the repository instead of fetched from the network. Each one is scheduled like a scraper under a `STATIC_<SOURCE>` key. See [Adding a country](../data/adding-a-country.md).

## Station {#station}

One place on the map: a fuel station, an EV charge point, or both. A station has a name, brand, address and position, and zero or more prices.

## Station leg {#station-leg}

The route redrawn through a station you pick while a route is on screen. The web app sends the station to [`POST /api/route`](api.md#route) as a [waypoint](#waypoint) and shows the new line. It keeps the stations it already found along the original route, so the list does not reload.

## Station type {#station-type}

One of `fuel`, `ev_charger` or `both`. Selecting the `EV` fuel shows stations of type `ev_charger` and `both`. See [Data model](data-model.md).

## Tankerkoenig {#tankerkoenig}

The service that republishes German fuel prices from the Markttransparenzstelle für Kraftstoffe (MTS-K), the federal market transparency unit for fuel. Pumperly's German fuel scraper needs a free Tankerkoenig API key in [`TANKERKOENIG_API_KEY`](environment-variables.md#tankerkoenig_api_key). See [API keys](../configuration/api-keys.md).

## Valhalla {#valhalla}

An open-source routing engine built on OpenStreetMap data. Pumperly uses it to plan routes and to compute [detours](#detour). Without [`VALHALLA_URL`](environment-variables.md#valhalla_url), route planning is unavailable and the rest of the map still works. See [Routing with Valhalla](../configuration/routing-valhalla.md).

## Waypoint {#waypoint}

A stop between the start and the end of a route. A route can have up to 5. Routes with waypoints get no [alternates](#alternate-route).
