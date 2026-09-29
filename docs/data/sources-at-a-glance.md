# Sources at a glance

One table per kind of source. The pages under Data sources explain each source in detail: [coverage and status](coverage.md), [fuel price sources](fuel-sources.md) and [EV charging sources](ev-sources.md).

## Fuel prices

| Country | Source | Type | Update |
|---|---|---|---|
| Spain | MITECO | Government API | Every 12h |
| France | prix-carburants.gouv.fr | Government API | Hourly |
| Germany | Tankerkoenig (MTS-K) | Government API | Hourly |
| Italy | MIMIT | Government CSV | Every 12h |
| Austria | E-Control | Government API | Every 2h |
| UK | CMA Open Data | Government feeds | Every 4h |
| Portugal | DGEG | Government API | Every 12h |
| Slovenia | goriva.si | Government API | Every 6h |
| Netherlands | ANWB | Commercial API | Every 6h |
| Belgium | ANWB | Commercial API | Every 6h |
| Luxembourg | ANWB | Commercial API | Every 12h |
| Romania | Peco Online | Community | Every 12h |
| Greece | FuelGR | Community API | Every 12h |
| Ireland | Pick A Pump | Community API | Blocked: the site now rejects scrapers (Cloudflare 403, robots disallow); no open alternative |
| Croatia | MZOE | Government API | Every 12h |
| Denmark | FuelPrices.dk | Commercial API | Every 6h |
| Norway | DrivstoffAppen | Government-mandated | Down: the public API was retired in 2026; drivstoffprisene.no needs a client id |
| Sweden | [bensinpriser.nu](https://bensinpriser.nu) | Community | Every 12h |
| Serbia | NIS / cenagoriva | Brand-level | Every 12h |
| Finland | polttoaine.net | Community | Every 12h |
| Iceland | [Gasvaktin](https://github.com/gasvaktin/gasvaktin) | Community (MIT) | Every 6h |
| Cyprus | [Consumer Protection Service observatory](https://eforms.eservices.cyprus.gov.cy/MCIT/MCIT/PetroleumPrices) | Government (CC BY-SA 4.0) | Every 6h |
| Taiwan | [CPC Corporation open data](https://data.gov.tw/dataset/6339) | Government list price (OGDL v1.0) | Every 12h |
| Switzerland, Poland, Czech Republic, Hungary, Bulgaria, Slovakia, Estonia, Latvia, Lithuania, Bosnia, North Macedonia | [Fuelo.net](https://fuelo.net) | Community | Paused since June 2026: Fuelo blocks the map endpoint; prices are frozen and no replacement is confirmed |
| Turkey | [Fuelo.net](https://fuelo.net) | Community | Paused since June 2026: Fuelo blocks the map endpoint; prices are frozen and no replacement is confirmed |
| Moldova | ANRE | Government | Every 12h |
| Australia (WA + NSW) | FuelWatch / FuelCheck | Government API | Every 12h (NSW needs `NSW_FUEL_API_KEY`; without it only WA updates) |
| Argentina | Secretaria de Energia | Government API | Down from Europe: datos.energia.gob.ar drops connections from EU addresses |
| Mexico | CRE | Government API | Every 12h |

## EV charging stations

| Source | Coverage | License |
|---|---|---|
| [Open Charge Map](https://openchargemap.org) | All supported countries + United States (EV-only) | ODbL |
| [Mapa REVE](https://www.mapareve.es) (Red Eléctrica de España) | Spain — official operator-reported registry | Non-commercial, attribution required |
| [Ladesäulenregister](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html) (Bundesnetzagentur) | Germany — official operator-reported registry, ~74,000 locations | CC BY 4.0, attribution "Bundesnetzagentur.de" |

Spain uses Mapa REVE when `PUMPERLY_REVE_API_KEY` is set: it is the registry every Spanish charge point operator files into, so it is authoritative where Open Charge Map is crowdsourced. The two overlap heavily, so Open Charge Map stops being scraped for Spain immediately, its existing Spanish rows stay visible while REVE backfills, and they are deleted once REVE reaches 95% of the registry. Expect duplicate Spanish pins until then.

Germany uses the BNetzA Ladesäulenregister by default — no API key, no signup. Every operator of a publicly accessible charge point must file into it under §5 Ladesäulenverordnung, so like REVE it is authoritative where Open Charge Map is crowdsourced, and it is several times larger. It arrives as one daily bulk file, so there is no backfill period: Open Charge Map stops being scraped for Germany, and its existing German rows are retired on the first healthy run. Set `PUMPERLY_DE_EV_SOURCE=ocm` to keep Open Charge Map instead.

## Map & routing

| Service | Purpose | License |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org) via [OpenFreeMap](https://openfreemap.org) | Map tiles | ODbL |
| [Valhalla](https://github.com/valhalla/valhalla) | Route calculation | MIT |
| [Photon](https://github.com/komoot/photon) (Komoot/OSM) | Geocoding / address search | Apache 2.0 |

## Supported countries

All 39 supported countries.

**Europe (33):** ES (Spain), FR (France), DE (Germany), IT (Italy), GB (United Kingdom), AT (Austria), PT (Portugal), SI (Slovenia), NL (Netherlands), BE (Belgium), LU (Luxembourg), RO (Romania), GR (Greece), IE (Ireland), HR (Croatia), CH (Switzerland), PL (Poland), CZ (Czech Republic), HU (Hungary), BG (Bulgaria), SK (Slovakia), DK (Denmark), SE (Sweden), NO (Norway), RS (Serbia), FI (Finland), EE (Estonia), LV (Latvia), LT (Lithuania), BA (Bosnia and Herzegovina), MK (North Macedonia), IS (Iceland), CY (Cyprus)

**Other regions (6):** TR (Turkey), MD (Moldova), AU (Australia), AR (Argentina), MX (Mexico), TW (Taiwan)
