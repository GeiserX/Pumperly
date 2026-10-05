# Pumperly — Roadmap

## Vision

The world's first open-source energy route planner that works for ALL vehicle types — fuel, electric, hybrid, hydrogen. Find the cheapest place to refuel or recharge along any route, with intelligent detour and range-aware recommendations.

---

## Phase 0: Foundation

**Goal**: Map with real fuel prices for Spain. Prove the core works.

### 0.1 — Project Scaffolding
- [x] Repository setup (GitHub, AGENTS.md, README)
- [x] Next.js 15 + App Router + TypeScript strict
- [x] Tailwind CSS + shadcn/ui setup
- [x] MapLibre GL JS + react-map-gl integration
- [x] OpenFreeMap as tile provider (Liberty style)
- [x] Basic responsive layout (map fills viewport)
- [x] Docker Compose for production (PostGIS + app via GitOps)

### 0.2 — Database + Spain Scraper
- [x] PostGIS schema via Prisma (stations, fuel_prices tables)
- [x] GiST spatial index on station geometry
- [x] Spain MITECO scraper (`src/scrapers/spain.ts`)
  - Fetch all ~12,000 stations + prices from `EstacionesTerrestres/`
  - Map 15 Spanish fuel types to EU harmonized codes (E5, E10, E5_98, B7, B7_PREMIUM, B_AGRICULTURAL, HVO, LPG, CNG, LNG, H2, ADBLUE, etc.)
  - Store with proper lat/lon geometry
- [x] Scraper CLI: `npx tsx src/scrapers/cli.ts --country=ES --once`
- [ ] Seed script for development

### 0.3 — Map View (Default Page)
- [x] Map centered on configurable country on first load (env vars: `PUMPERLY_DEFAULT_COUNTRY`)
- [x] Station markers from PostGIS via bbox API: `GET /api/stations?bbox=...&fuel=B7`
- [x] MapLibre GeoJSON source with `cluster: true` (GPU clustering, clusterMaxZoom=9, clusterRadius=45)
- [x] Color-coded markers: P5/P95 percentile-based 7-color rainbow gradient (green→red→purple) with dynamic price legend
- [x] Click marker → popup with: brand (bold heading), address + city, large price, fuel type + relative time ("Actualizado hace Xh")
- [x] Fuel type selector dropdown (15 types, grouped: Diésel, Gasolina, Gas, Hidrógeno, Otros)
- [x] Price filter: max price slider (bottom-right, real-time filtering, shows station count)

### 0.3b — Navbar & Stats (bonus, not in original plan)
- [x] Dark navbar (#0c111b, 44px) with Pumperly logo (emerald-to-cyan gradient bolt + wordmark)
- [x] Stats dropdown: station/price totals, per-country breakdown with flags, last update timestamps
- [x] "Made with ♥ by Sergio Fernández" footer + GitHub Sponsors button
- [x] GitHub Actions CI/CD: lint, typecheck, Docker build+push to Docker Hub (`drumsergio/pumperly`)

### 0.4 — Geolocation + Nearby
- [x] Browser geolocation API (with consent prompt)
- [x] "Center on me" button (top-right, flies to location at zoom 12)
- [x] Auto-zoom to user area if geolocation granted
- [x] Fallback: env-var-based country center (configurable via `PUMPERLY_DEFAULT_COUNTRY`)

**Deliverable**: A working map at `pumperly.geiser.cloud` showing all ~12,000 Spanish fuel stations with real prices for 15 fuel types, P5/P95 color scale, clustered map, dark navbar with stats.

---

## Phase 1: Route Planning

**Goal**: Plan a route A→B and see fuel stations along it.

### 1.1 — Valhalla Integration
- [x] Docker Compose: add Valhalla service (5-country tiles: ES, FR, PT, IT, AT)
- [x] Valhalla API client (`src/lib/valhalla.ts`)
- [x] Route endpoint: `POST /api/route` (origin, destination, optional waypoints)
- [x] Returns: polyline (GeoJSON), distance, duration, legs

### 1.2 — Search / Geocoding
- [x] Photon geocoding client (`src/lib/photon.ts`)
- [x] Route search component: origin + destination inputs with typeahead autocomplete
- [x] Debounced Photon requests (300ms)
- [x] Geo-biased results (user location passed as lat/lon)
- [x] "Add waypoint" button (up to 5 intermediate stops)
- [x] Swap origin/destination button (also reverses waypoints)

### 1.3 — Route Display
- [x] Draw route polyline on map (MapLibre `addLayer` type `line`)
- [x] Blue route line with outline for visibility
- [x] Auto-fit map bounds to show full route
- [x] Route info panel: total distance, total duration, number of legs
- [x] Alternative routes via Valhalla `alternates` parameter (violet/teal/amber colored lines, click to switch primary)

### 1.4 — Stations Along Route
- [x] Corridor query using PostGIS `ST_DWithin`:
  - Uses PostGIS geography-aware `ST_DWithin` with 5km default corridor
  - Route geometry passed as WKT LineString to PostGIS
  - `SELECT * FROM stations WHERE ST_DWithin(geom::geography, route::geography, 5000)`
- [x] Show corridor stations on map with fuel prices (all routes, deduplicated)
- [x] Station list panel: sorted by position along route (routeFraction via ST_LineLocatePoint)
- [x] Highlight stations that are directly on the route vs requiring detour (detour badge in list)

**Deliverable**: Plan a route Madrid→Barcelona, see all fuel stations within 5km of the route with prices.

---

## Phase 2: Smart Features

**Goal**: The killer features no competitor has.

### 2.1 — Detour Calculation
- [x] For each corridor station, estimate detour time via `ST_Distance` (round trip, 1.3x road factor, 40 km/h)
- [ ] Upgrade to Valhalla matrix API for top-N candidates (more accurate, future)
- [x] Display detour time in station list panel (+N min badge)
- [x] Detour data computed inline in `/api/route-stations` (no separate endpoint needed)

### 2.2 — "Cheapest Within N Minutes Detour" Mode
- [x] Detour slider in station list panel (0-15 min)
- [x] Filters both map markers and station list simultaneously
- [x] "MEJOR" (best deal) badge on cheapest station within current detour filter
- [x] Show savings comparison: per-station delta vs route average price (green negative, gray positive)

### ~~2.3 — "Best Station in Area" Mode~~ (skipped)

### 2.4 — "Smart Refuel by Range" Mode
- [ ] User inputs: remaining range (km) and tank capacity (liters)
- [ ] Sweet zone algorithm:
  ```
  Zone           | Range %   | Multiplier | Behavior
  too_early      | 0-25%     | 0.3        | Low value, tank still full
  sweet_spot     | 25-65%    | 1.0        | Ideal — best options, no rush
  getting_late   | 65-80%    | 0.7        | Acceptable, fewer options
  danger_zone    | 80-90%    | 0.2        | Emergency fallback only
  never          | 90-100%   | 0.0        | Never recommend — stranding risk
  ```
- [ ] Score function: `(price_savings * fill_amount) - (detour_penalty * time_value) * zone_multiplier`
- [ ] Present top 3 recommendations with reasoning:
  - "Best value: Shell A-30 km 142 — 1.389 EUR/L, 3 min detour, saves 4.20 EUR"
  - "Closest cheap: Repsol Albacete — 1.399 EUR/L, on route"
  - "Cheapest overall: Plenoil Bonete — 1.359 EUR/L, 7 min detour"
- [ ] Visual: highlight sweet zone on route as green segment, danger as red

**Deliverable**: Full smart refueling system — the feature that makes Pumperly unique worldwide.

---

## Phase 3: Multi-Country Expansion

**Goal**: Cover 31 European countries with 100,000+ stations.

### 3.1 — Scraper Framework
- [x] Abstract base scraper with shared logic (upsert, dedup, error handling) — `BaseScraper` class
- [x] Scraper CLI: `npx tsx src/scrapers/cli.ts --country=all`
- [x] Automatic scraping via `instrumentation.ts` (configurable interval via `PUMPERLY_SCRAPE_INTERVAL_HOURS`)
- [x] Per-country enable/disable via `PUMPERLY_ENABLED_COUNTRIES` env var
- [ ] Scraper health monitoring (last successful run, station count, error rate)

### 3.2 — Country Scrapers (31 countries)
- [x] France scraper (`data.economie.gouv.fr` OpenDataSoft API, ~9,800 stations)
- [x] Portugal scraper (DGEG API, ~3,200 stations, paginated per fuel type)
- [x] Italy scraper (MIMIT CSV, ~23,600 stations, pipe-delimited)
- [x] Austria scraper (E-Control API, ~930 stations, queried per district for max coverage)
- [x] Germany scraper (Tankerkoenig v4 API, ~14,347 stations, CC BY 4.0)
- [x] UK scraper (CMA 14 retailer feeds, ~3,536 stations, Open Government Licence v3.0)
- [x] Slovenia scraper (goriva.si API, ~551 stations, government-regulated prices)
- [x] Netherlands scraper (ANWB API, ~3,893 stations, EUR)
- [x] Belgium scraper (ANWB API, ~3,190 stations, EUR)
- [x] Luxembourg scraper (ANWB API, ~237 stations, EUR)
- [x] Romania scraper (Peco Online Parse API, ~1,386 stations, RON)
- [x] Greece scraper (FuelGR/deixto.gr XML API, ~2,500+ stations, EUR, grid-based)
- [x] Ireland scraper (Pick A Pump API, ~1,345 stations, EUR, grid-based nearby queries)
- [x] Croatia scraper (MZOE government API, ~911 stations, EUR, single JSON dump)
- [x] Switzerland, Poland, Czech Republic, Hungary, Bulgaria, Slovakia, Estonia, Latvia, Lithuania, Bosnia, North Macedonia scrapers (Fuelo.net, community-sourced)
- [x] Denmark scraper (FuelPrices.dk API)
- [x] Sweden scraper (Drivstoffappen, community-sourced)
- [x] Norway scraper (DrivstoffAppen, government-mandated)
- [x] Serbia scraper (NIS + cenagoriva, brand-level)
- [x] Finland scraper (polttoaine.net, community-sourced)

### 3.3 — Valhalla Multi-Country Tiles
- [x] Valhalla configured with 31-country merged PBF
- [x] PBFs merged with osmium-tool to avoid Valhalla multi-PBF SIGABRT bug
- [ ] Automated monthly tile rebuild (cron or triggered by Geofabrik update)

### 3.4 — Internationalization
- [x] Lightweight i18n system (`src/lib/i18n.tsx`) — React context + localStorage
- [x] 16 locales: es, en, fr, de, it, pt, pl, cs, hu, bg, sk, da, sv, no, sr, fi
- [x] Language selector in navbar
- [x] Translated: search panel, station list, badges, detour slider
- [x] Auto-detect locale from browser `navigator.languages`
- [x] All UI strings internationalized (popup, price filter, geolocate, fuel categories)
- [ ] Currency formatting per locale (EUR, GBP, PLN)
- [ ] Fuel type names localized per country

### 3.5 — Photon Multi-Country Geocoding
- [x] Photon configured to import 31 countries from per-country dumps
- [x] Serves all 22 languages (es, en, fr, de, it, pt, sl, nl, ro, el, ga, hr, pl, cs, hu, bg, sk, da, sv, no, sr, fi)
- [x] Cross-border routing works (e.g., Madrid → Paris)

### 3.6 — Cross-Border Features (future)
- [ ] Show price differences at borders ("Diesel is 15c/L cheaper in Spain")
- [ ] Currency conversion for comparison (always show in user's preferred currency)
- [ ] Border-crossing fuel strategy recommendations

**Deliverable**: 31 countries, 100K+ stations, 16 languages, cross-border routing.

---

## Phase 4: Polish & UX

**Goal**: Production-quality UX that rivals Google Maps.

### 4.1 — Mobile UX
- [ ] Bottom sheet pattern for station details (swipe up/down, like Google Maps)
- [ ] Mobile-optimized route search (full-screen search overlay)
- [ ] Touch-friendly controls (larger tap targets, swipe gestures)
- [ ] Responsive sidebar → bottom panel transition at mobile breakpoint

### 4.2 — Station Detail Pages
- [ ] `/{locale}/station/{id}` — ISR pages (revalidate every 30 min)
- [ ] SEO: "Gasolinera Repsol Murcia — Gasoleo A 1.389 EUR/L"
- [ ] Price history chart (last 30 days, 90 days, 1 year)
- [ ] Opening hours
- [ ] Amenities (car wash, shop, restaurant, toilets)
- [ ] User reviews/ratings (future)
- [ ] "Navigate here" button (deep link to Google Maps / Waze / Apple Maps)

### 4.3 — Vehicle Profile
- [ ] Save vehicle details: fuel type, tank capacity, avg consumption (L/100km or kWh/100km)
- [ ] Auto-calculate range from tank level
- [ ] Route fuel cost estimation using vehicle profile
- [ ] Local storage (no account needed)

### 4.4 — Visual Polish
- [ ] Dark mode (Tailwind `dark:` + MapLibre dark style)
- [ ] Smooth animations for panel transitions
- [ ] Loading skeletons for map + panels
- [ ] Empty states and error boundaries
- [ ] Price change indicators (arrow up/down vs yesterday)

### 4.5 — PWA + Offline
- [ ] @serwist/next service worker
- [ ] App shell caching
- [ ] Offline base map via PMTiles (regional extract in IndexedDB)
- [ ] Offline station data cache (last known prices)
- [ ] Add-to-homescreen prompt
- [ ] Background sync for price updates when back online

**Deliverable**: A polished, mobile-first PWA that users actually want to install.

---

## Phase 5: EV Charging Integration

**Goal**: Extend Pumperly to electric vehicles — the ABRP killer.

### 5.1 — EV Data Sources (Researched)

**Primary: Open Charge Map (OCM)** — open source, global, 270K+ chargers, CC BY-SA 4.0.
- API: `GET https://api.openchargemap.io/v3/poi/?countrycode=ES&maxresults=100000&compact=true&key=KEY`
- **API key required** (free): register at openchargemap.org → My Profile → My Apps → Register
- Pagination: use `greaterthanid=MAX_ID` + `sortby=id_asc` + `maxresults=10000` for bulk export
- Incremental sync: `modifiedsince=YYYY-MM-DD` for updates since last scrape
- Rich data: connector types, power (kW), operator/network, usage type (public/private/membership)
- **No real-time availability** — `StatusType` is editorial/crowdsourced, not live OCPP
- **No structured pricing** — only `UsageCost` free-text field (e.g. "0.39 EUR/kWh")
- Rate limits: no published numbers, but auto-banning for abuse. Use 100ms+ delay between pages.
- Robot user-agents are blocked (set proper `User-Agent: Pumperly/1.0`)

**National registries (supplement OCM with authoritative data):**
- **France IRVE** — daily CSV/GeoJSON, ~50K+ charging points, Licence Ouverte v1.0. Structured connector types, power, pricing, EVSE IDs. URL: `data.gouv.fr` dataset `eb76d20a-8501-400e-b336-d85724de5435`
- **Germany BNetzA** — monthly XLSX/CSV (~26-45MB), CC BY 4.0. All legally-registered operators. URL: `data.bundesnetzagentur.de`
- **Spain** — no single national registry; ~22 fragmented regional datasets on datos.gob.es (Madrid, Barcelona, Navarra, etc.)
- **Austria E-Control** — charging point registry at e-control.at, CC BY 4.0
- **Italy PUN** — piattaformaunicanazionale.it (new, needs evaluation)
- **Portugal** — only municipal-level datasets on dados.gov.pt

**Other free sources:**
- **OpenStreetMap** via Overpass API — tag `amenity=charging_station`, good coverage, ODbL license
- **OCPI protocol** — B2B between CPOs and eMSPs, not a public API. Useful for real-time if we partner with a network.

**Commercial (future fallback):** Eco-Movement (pan-European, paid), HERE EV API (paid), TomTom EV API (paid)

**Implementation strategy:** OCM bulk import per country → supplement with France IRVE + Germany BNetzA → OSM for validation/enrichment → accept that real-time availability needs commercial APIs or direct OCPI integrations.

- [x] OCM scraper: per-country import for all 31 countries (5000 POIs per country, 24h interval)
- [x] Station type field: `fuel`, `ev_charger`, or `both` — stored in stations table
- [x] EV fuel type (`EV`) with electric category in UI, lightning bolt icon
- [x] Stations API: separate query path for EV (no price join)
- [x] Route stations API: EV corridor query support
- [x] Legal modal: OCM attribution (ODbL)
- [ ] France IRVE scraper: daily CSV download (209K stations, no auth needed)
- [ ] Germany BNetzA scraper: monthly XLSX download (128K facilities)
- [ ] Netherlands NDW OCPI scraper (53K stations, real-time status)
- [ ] Connector type, power (kW), price per kWh (structured), network metadata

### 5.2 — EV Route Planning
- [ ] Battery level input (% or kWh remaining)
- [ ] Vehicle profile: battery capacity, consumption (kWh/100km), max charge speed
- [ ] Range prediction along route (accounting for elevation, speed, weather)
- [ ] Smart charging stop recommendations:
  - Minimize total trip time (balance charge speed vs detour)
  - Minimize cost (compare charger prices)
  - Ensure sufficient range buffer at all points
- [ ] Charging time estimation per stop (based on SoC curve + charger power)

### 5.3 — Hybrid View
- [ ] Toggle between fuel stations, EV chargers, or both on map
- [ ] Combined route planning for PHEVs (plug-in hybrids)
- [ ] Hydrogen station layer (for FCEV support)

**Deliverable**: Pumperly becomes the first app that optimizes energy stops for ANY vehicle type.

---

## Phase 6: Community & Data Quality

### 6.1 — Crowdsourced Prices
- [ ] "Report price" button (no account needed, rate-limited by IP)
- [ ] Community price validation (flag outdated government data)
- [ ] Trust scoring for reports

### 6.2 — Price Alerts
- [ ] "Notify me when diesel drops below X in my area"
- [ ] Web Push notifications (no email, no accounts)
- [ ] Daily price digest (optional)

### 6.3 — API for Developers
- [ ] Public REST API: `/api/v1/stations`, `/api/v1/prices`, `/api/v1/route`
- [ ] Rate limiting (100 req/min free)
- [ ] OpenAPI/Swagger docs
- [ ] Encourage third-party apps and integrations

---

## Phase 7: Global Expansion

### 7.1 — More European Countries (Researched)

**Tier 1 — Station-level data, open APIs:**
- [x] UK — CMA Open Data Scheme: 13 retailer JSON endpoints (Shell excluded — HTML), 3,536 stations, GBP pence
- [x] Slovenia — goriva.si REST API, 551 stations, 9 fuel types incl. HVO/CNG/LNG
- [x] Netherlands — ANWB API (`api.anwb.nl`, no auth, ~3,893 stations, EUR)
- [x] Greece — FuelGR/Deixto.gr reverse-engineered Android app XML API (~3,111 stations, EUR, grid-based queries)
- [x] Romania — Peco-Online Parse API (~1,386 stations, RON)
- [x] Belgium — ANWB API (`api.anwb.nl`, no auth, ~3,190 stations, EUR, station-level prices)
- [x] Luxembourg — ANWB API (`api.anwb.nl`, no auth, ~237 stations, EUR, station-level prices)
- [x] Ireland — Pick A Pump API (`api.pickapump.com`, ~1,345 stations, EUR, grid-based nearby queries)
- [x] Croatia — MZOE government API (`mzoe-gor.hr/data.json`, ~897 stations, EUR, single JSON dump, coords swapped)

**Tier 2 — Government data, national/regional averages only (no station-level):**
- [ ] Czech Republic — CZSO: weekly/monthly average consumer fuel prices, CSV/JSON, CC BY 4.0.
- [ ] Finland — Statistics Finland PxWeb API: monthly national averages since 1988.
- [ ] Serbia — cenagoriva.rs has brand-level prices (6 brands, HTML scrape), no station-level data. Government sets max prices per brand.

**Tier 3 — No usable open data found:**
- [ ] Switzerland — no government mandate; Comparis.ch has data but behind DataDome bot protection, no public API. TCS/Avenergy only publish aggregates.
- [ ] Slovakia — exhaustive search of 9 sources (natankuj.sk, data.gov.sk, URSO, SOI, Slovnaft, OMV WiGeoGIS). No station-level price data.
- [ ] Estonia — Olerex has station JSON API (locations, no prices). No government fuel price portal.
- [ ] Latvia — degviela.info tested, no public API. No government station-level data.
- [ ] Lithuania — no government station-level data found.
- [ ] Poland — no government station-level data; e-petrol.pl is paywalled; Orlen API has stations but no prices
- [ ] Bulgaria — no government API found
- [ ] Hungary — price regulation ended 2022; holtankoljak.hu unreachable; no public API
- [ ] Sweden — no API; bensinpriser.nu is crowdsourced, no public API
- [ ] Norway — not EU (EEA); DrivstoffAppen.no (1M+ users) API not public
- [ ] Denmark — no API; would need per-retailer scraping (Circle K, Q8, Shell, etc.)

**Cross-country fallbacks:**
- EU Weekly Oil Bulletin — all 27 EU states, national averages, weekly XLSX downloads from `energy.ec.europa.eu`
- fuel-prices.eu — CC BY 4.0 REST API aggregating Weekly Oil Bulletin data, country averages only

### 7.2 — Outside Europe
- [ ] USA — no single official API, explore:
  - GasBuddy (no public API, scraping TOS issues)
  - OPIS (commercial)
  - State-level data sources
  - Crowdsourced as primary
- [ ] Canada
- [ ] Australia (FuelWatch WA is open, others vary by state)
- [ ] Latin America

### 7.3 — Commercial Data Fallback
- [ ] TomTom Fuel Prices API (global, freemium)
- [ ] HERE Fuel Prices API (global, freemium)
- [ ] Use commercial APIs to fill gaps where no government data exists

---

## Technical Debt & Infrastructure

### Ongoing
- [ ] Valhalla tile rebuilds (monthly cron, or triggered by Geofabrik update)
- [ ] PostGIS vacuum and index maintenance
- [ ] Scraper error monitoring and alerting
- [ ] Performance monitoring (response times, map load times)
- [ ] Database backups (pg_dump to NAS)

### Future Infrastructure
- [ ] CDN for static assets (Cloudflare)
- [ ] Protomaps PMTiles on Cloudflare R2 for global tile delivery
- [ ] Consider Hetzner VPS if the deploy host becomes resource-constrained
- [ ] Rate limiting on API routes (middleware)

---

## Performance Targets

| Operation | Target | Expected |
|---|---|---|
| Route calculation | < 2s | 100-500ms (Valhalla NVMe) |
| Station corridor search | < 1s | 50-200ms (PostGIS GiST) |
| Detour matrix calculation | < 1s | 50-200ms (Valhalla matrix) |
| Full smart refuel pipeline | < 3s | 500ms-1.5s |
| Map tile loading | < 500ms | 50-200ms (local PMTiles) |
| First Contentful Paint | < 1.5s | ~1s (SSR + streaming) |
| Time to Interactive | < 3s | ~2s |

---

## Competitive Position

| Feature | Pumperly | GasBuddy | Waze | ViaMichelin | ABRP |
|---|---|---|---|---|---|
| Route planning | Yes | Yes | Yes (nav) | Yes | Yes |
| Real-time prices along route | Yes | Yes | Limited | No (estimates) | N/A (EV) |
| **Detour time calculation** | **Yes** | No | No | No | N/A |
| **Smart refuel by range** | **Yes** | No | No | No | Yes (EV) |
| Multi-country Europe | Yes (31) | No (US/CA) | Partial | Partial | Yes (EV) |
| Fuel + EV support | Yes | No | No | No | EV only |
| Open source | Yes | No | No | No | No |
| Self-hostable | Yes | No | No | No | No |

---

*Last updated: March 2026 — v1.0.0*
