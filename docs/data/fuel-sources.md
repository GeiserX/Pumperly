# Fuel price sources

This page describes every fuel price source Pumperly reads: what the source is, how the scraper reads it, which fuels it maps and what to watch out for. [Coverage and status](coverage.md) has the one-table summary; this page has the detail.

## How to read this page {#how-to-read-this-page}

Each source has a short fact table:

- **Source key** is the value the scraper writes into the `source` column of every price row. The scraper's log lines start with it, for example `[miteco]`.
- **Scraper** links to the file that does the work.
- **Every** is the default interval between runs. [Countries and scrape schedule](../configuration/countries-and-schedule.md) explains how to change it.
- **Licence** appears only where the project records one. The app lists its data providers in its **Data Sources** dialog.

Each source also has a fuel table. It maps the source's own fuel names to Pumperly's fuel codes. A fuel the source publishes but the table leaves out is not imported, unless the section describes a fallback rule for unlisted names. [Fuel types](../reference/fuel-types.md) explains each code.

### What every source has in common {#common-behaviour}

All scrapers share one pipeline, described in [How scrapers work](how-scrapers-work.md). Four parts of it matter when you read the sections below:

- **Implausible prices are dropped.** Each currency has a plausible per-litre range, so a placeholder like `999999` or a price in the wrong unit never reaches the map.
- **A station with no valid price is dropped.** Only stations with at least one price are written.
- **Each run replaces the source's prices for its country in one transaction.** The map never shows half a run.
- **A station missing from a run disappears.** When a run no longer lists a station, its prices go, and the station is deleted unless another source still prices it. For grid-based scrapers, a grid point that fails for one run can hide its stations until the next good run.

## Government and official sources {#government-sources}

### Argentina {#argentina}

The Secretaría de Energía publishes pump prices as an open-data CSV file. Each row is one station, one fuel and one time band.

| | |
|---|---|
| Source key | `energia_ar` |
| Scraper | [`src/scrapers/argentina.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/argentina.ts) |
| Currency | ARS |
| Every | 12 h |
| API key | None |

| Source fuel | Code |
|---|---|
| Nafta (súper) entre 92 y 95 Ron | `E5` |
| Nafta (premium) de más de 95 Ron | `E5_PREMIUM` |
| Gas Oil Grado 2 | `B7` |
| Gas Oil Grado 3 | `B7_PREMIUM` |
| GNC | `CNG` |

Things to know:

- **The server does not answer from Europe.** `datos.energia.gob.ar` drops connections from European addresses, so this scraper only works from a server in the Americas.
- **Only daytime prices are used.** The file lists day (`Diurno`) and night prices separately. The scraper keeps the daytime rows.
- **A station is identified by its tax id and coordinates.** A station whose coordinates change gets a new identity, and the old one is removed.

### Australia, Western Australia {#australia-western-australia}

FuelWatch is the Western Australian government's fuel price service. It publishes one RSS feed per fuel product.

| | |
|---|---|
| Source key | `fuelwatch_wa` |
| Scraper | [`src/scrapers/australia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/australia.ts) |
| Scraper key | `AU` |
| Currency | AUD |
| Every | 12 h |
| API key | None |

| FuelWatch product | Code |
|---|---|
| 1, Unleaded Petrol | `E10` |
| 2, Premium Unleaded | `E5_PREMIUM` |
| 4, Diesel | `B7` |
| 5, LPG | `LPG` |
| 6, 98 RON | `E5_98` |
| 11, Premium Diesel | `B7_PREMIUM` |

Things to know:

- **Prices arrive in cents per litre.** The scraper divides by 100.
- **One request per product.** A product whose feed fails is skipped for that run, and its prices disappear until the next good run.

### Australia, New South Wales {#australia-new-south-wales}

FuelCheck is the New South Wales government's fuel price API. It returns every station and every price in one response.

| | |
|---|---|
| Source key | `nsw_fuelcheck` |
| Scraper | [`src/scrapers/australia-nsw.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/australia-nsw.ts) |
| Scraper key | `AU_NSW` |
| Currency | AUD |
| Every | 12 h |
| API key | `NSW_FUEL_API_KEY` and `NSW_FUEL_API_SECRET`, both required |

| FuelCheck code | Code |
|---|---|
| `U91` | `E5` |
| `E10` | `E10` |
| `P95` | `E5_PREMIUM` |
| `P98` | `E5_98` |
| `DL` | `B7` |
| `PDL` | `B7_PREMIUM` |
| `LPG` | `LPG` |
| `B20` | `B10` |

Things to know:

- **Without both credentials, every run fails.** The scraper exchanges the key and secret for an access token on each run, then fetches prices. That is two requests per run.
- **B20 biodiesel is filed as `B10`.** The fuel model has no B20 code, and `B10` is the closest.
- **Prices arrive in cents per litre.** The scraper divides by 100.

### Austria {#austria}

E-Control, the Austrian energy regulator, runs the Spritpreisrechner. Its API answers "which stations are near this point" for one fuel at a time.

| | |
|---|---|
| Source key | `econtrol` |
| Scraper | [`src/scrapers/austria.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/austria.ts) |
| Currency | EUR |
| Every | 2 h |
| API key | None |

| E-Control code | Code |
|---|---|
| `DIE` | `B7` |
| `SUP` | `E5` |
| `GAS` | `E10` |

Things to know:

- **Austria is covered with a grid.** The scraper queries points about 15 km apart across the country, once per fuel. That is about 2,200 requests per run.
- **Closed stations are excluded.** The scraper asks for open stations only.
- **Failed grid points are skipped silently.** When a station shows up in several queries, the cheapest price for each fuel is kept.

### Croatia {#croatia}

The Croatian ministry's fuel price monitoring system (MZOE) publishes every station, its operator and its current prices as one JSON file.

| | |
|---|---|
| Source key | `mzoe` |
| Scraper | [`src/scrapers/croatia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/croatia.ts) |
| Currency | EUR |
| Every | 12 h |
| API key | None |

| MZOE fuel kind | Code |
|---|---|
| 1, Eurosuper 95 with additives | `E5_PREMIUM` |
| 2, Eurosuper 95 | `E5` |
| 5, Eurosuper 100 with additives | `E5_98` |
| 6, Eurosuper 100 | `E5_98` |
| 7, Eurodizel with additives | `B7_PREMIUM` |
| 8, Eurodizel | `B7` |
| 9, UNP (autogas) | `LPG` |
| 11, Blue diesel | `B_AGRICULTURAL` |

Things to know:

- **Latitude and longitude are swapped upstream.** The field named `lat` holds the longitude and `long` holds the latitude. The scraper swaps them back.
- **Several products can share one fuel code.** When they do, the cheapest price is kept.
- **Prices outside 0.30 to 4.00 EUR per litre are dropped** before the shared checks run.
- **The brand is the operator's name** with legal suffixes such as `d.d.` and `d.o.o.` removed.

### Cyprus {#cyprus}

The Consumer Protection Service runs a retail fuel price observatory. It is a web form that lists every station's pump price for one fuel at a time.

| | |
|---|---|
| Source key | `cy_observatory` |
| Scraper | [`src/scrapers/cyprus.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/cyprus.ts) |
| Currency | EUR |
| Every | 6 h |
| API key | None |
| Licence | CC BY-SA 4.0: credit the Consumer Protection Service and share derived data alike |

| Observatory fuel | Code |
|---|---|
| 1, Unleaded 95 | `E5` |
| 2, Unleaded 98 | `E5_98` |
| 3, Diesel | `B7` |

Things to know:

- **Four requests per run.** The scraper loads the form once, then submits it once per fuel.
- **Stations have no id upstream.** The scraper identifies each station by its coordinates, rounded to 5 decimal places (about 1 m).
- **Coordinates come in two formats.** Most are decimal degrees. Some are degrees, minutes and seconds, such as `34°39'13.5"N 32°58'26.3"E`. The scraper reads both.
- **Offline stations are skipped.** The observatory marks stations that stopped reporting, and their prices may be stale.

### France {#france}

The French government publishes live pump prices on data.economie.gouv.fr, in the dataset `prix-des-carburants-en-france-flux-instantane-v2`. The scraper downloads the whole dataset in one bulk export.

| | |
|---|---|
| Source key | `economie_gouv` |
| Scraper | [`src/scrapers/france.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/france.ts) |
| Currency | EUR |
| Every | 1 h |
| API key | None |
| Licence | Licence Ouverte v2.0 |

| Source field | Code |
|---|---|
| `gazole_prix` | `B7` |
| `sp95_prix` | `E5` |
| `e10_prix` | `E10` |
| `sp98_prix` | `E5_98` |
| `e85_prix` | `E10` |
| `gplc_prix` | `LPG` |

Things to know:

- **E85 is filed as `E10`.** The fuel model has no E85 code. A station that sells both E10 and E85 therefore has two `E10` prices, and the map may show either one.
- **Mainland France and Corsica only.** Stations outside 41–52° N and 6° W–10° E, which includes the overseas departments, are skipped.
- **The export has no brand.** Station names are built from the town and the address.
- The dataset is refreshed upstream about every 10 minutes. Pumperly reads it hourly.

### Germany {#germany}

Tankerkoenig republishes the prices German stations must report to the Markttransparenzstelle für Kraftstoffe (MTS-K), the Federal Cartel Office's fuel price transparency unit.

| | |
|---|---|
| Source key | `tankerkoenig` |
| Scraper | [`src/scrapers/germany.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/germany.ts) |
| Currency | EUR |
| Every | 1 h |
| API key | `TANKERKOENIG_API_KEY`, required. Register at [onboarding.tankerkoenig.de](https://onboarding.tankerkoenig.de) |
| Licence | CC BY 4.0 |

| Tankerkoenig fuel | Code |
|---|---|
| Diesel | `B7` |
| Super E5 | `E5` |
| Super E10 | `E10` |
| Super Plus | `E5_98` |
| Any other fuel in the `diesel` category | `B7` |
| Any other fuel in the `gasoline` category | `E5` |

Things to know:

- **Without the key, every run fails at once.** Nothing is written, and German fuel prices stay as they were.
- **Germany is covered with a grid.** The API searches a radius of at most 25 km, so the scraper queries about 340 overlapping circles, with a 100 ms pause between requests.
- **A rate-limited point is skipped, not retried.** When the API answers HTTP 503, the scraper waits 10 seconds and moves on to the next point.

### Italy {#italy}

MIMIT, the Italian ministry for enterprise, publishes two pipe-delimited CSV files each day: the registry of active stations and the latest prices.

| | |
|---|---|
| Source key | `mimit` |
| Scraper | [`src/scrapers/italy.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/italy.ts) |
| Currency | EUR |
| Every | 12 h |
| API key | None |
| Licence | Italian Open Data License v2.0 |

| MIMIT fuel name | Code |
|---|---|
| Benzina | `E5` |
| Benzina speciale, Blue Super, HiQ Perform+ | `E5_PREMIUM` |
| Gasolio, Gasolio Alpino | `B7` |
| Gasolio speciale, HiQ Diesel, Blue Diesel | `B7_PREMIUM` |
| GPL | `LPG` |
| Metano, L-GNC | `CNG` |
| GNL | `LNG` |

Things to know:

- **Unlisted names are matched by keyword.** A name containing `gasolio` or `diesel` becomes `B7`, `benzina` or `super` becomes `E5`, `gpl` becomes `LPG`, `metano` or `gnc` becomes `CNG`, and `gnl` becomes `LNG`.
- **Self-service and attended prices share a code.** The price file lists both, and the scraper stores both under the same fuel code. The map shows one of them.
- **A price whose station is not in the registry file is skipped.**

### Mexico {#mexico}

The Comisión Reguladora de Energía (CRE) publishes two XML feeds: station locations and station prices.

| | |
|---|---|
| Source key | `cre_mx` |
| Scraper | [`src/scrapers/mexico.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/mexico.ts) |
| Currency | MXN |
| Every | 12 h |
| API key | None |

| CRE fuel | Code |
|---|---|
| `regular` | `E5` |
| `premium` | `E5_PREMIUM` |
| `diesel` | `B7` |

Things to know:

- **Only stations in both feeds are written.** A station needs a location and at least one price.
- **The feeds carry no street address.** Stations show their name and position only.

### Moldova {#moldova}

ANRE, the Moldovan energy regulator, runs the eCarburanți public API. One request returns every station with its current prices.

| | |
|---|---|
| Source key | `anre_md` |
| Scraper | [`src/scrapers/moldova.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/moldova.ts) |
| Currency | MDL |
| Every | 12 h |
| API key | None |

| ANRE field | Code |
|---|---|
| `gasoline` | `E5` |
| `diesel` | `B7` |
| `gpl` | `LPG` |

Things to know:

- **Coordinates arrive in Web Mercator (EPSG:3857).** The scraper converts them to latitude and longitude.
- **Inactive stations are skipped.** These are stations whose status code is 4.
- **A station is identified by its company id and coordinates.** A station whose coordinates change gets a new identity, and the old one is removed.

### Portugal {#portugal}

DGEG, the Portuguese directorate-general for energy, runs a price search API. It returns stations for one fuel at a time, 500 per page.

| | |
|---|---|
| Source key | `dgeg` |
| Scraper | [`src/scrapers/portugal.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/portugal.ts) |
| Currency | EUR |
| Every | 12 h |
| API key | None |
| Licence | Non-commercial use only |

| DGEG fuel id | Code |
|---|---|
| 2101, Gasóleo simples | `B7` |
| 2105, Gasóleo especial | `B7_PREMIUM` |
| 3201, Gasolina simples 95 | `E5` |
| 3205, Gasolina especial 95 | `E5_PREMIUM` |
| 3400, Gasolina 98 | `E5_98` |
| 1120, GPL Auto | `LPG` |
| 1143, GNC | `CNG` |

Things to know:

- **Mainland Portugal only.** Stations outside 36–43° N and 10° W–6° W are skipped, which excludes Madeira and the Azores.
- **Prices arrive as text,** such as `1,679 €`. The scraper parses the number.

### Slovenia {#slovenia}

goriva.si publishes Slovenian pump prices through a search API. One search, centred on the country with a 200 km radius, covers all of it.

| | |
|---|---|
| Source key | `goriva_si` |
| Scraper | [`src/scrapers/slovenia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/slovenia.ts) |
| Currency | EUR |
| Every | 6 h |
| API key | None |

| goriva.si field | Code |
|---|---|
| `95` | `E5` |
| `98` | `E5_98` |
| `100` | `E5_PREMIUM` |
| `dizel` | `B7` |
| `dizel-premium` | `B7_PREMIUM` |
| `avtoplin-lpg` | `LPG` |
| `hvo` | `HVO` |
| `cng` | `CNG` |
| `lng` | `LNG` |

Things to know:

- **Results are paged.** The scraper follows each page's `next` link, with a 200 ms pause between pages.
- **The brand stays empty.** The feed gives the brand only as a numeric franchise id, which the scraper does not map.

### Spain {#spain}

MITECO, the Spanish ministry for the ecological transition, publishes every station and its prices through one REST endpoint. The list holds about 12,000 stations.

| | |
|---|---|
| Source key | `miteco` |
| Scraper | [`src/scrapers/spain.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/spain.ts) |
| Currency | EUR |
| Every | 12 h |
| API key | None |

| MITECO field | Code |
|---|---|
| Precio Gasoleo A | `B7` |
| Precio Gasoleo Premium | `B7_PREMIUM` |
| Precio Gasoleo B | `B_AGRICULTURAL` |
| Precio Diésel Renovable | `HVO` |
| Precio Gasolina 95 E5 | `E5` |
| Precio Gasolina 95 E5 Premium | `E5_PREMIUM` |
| Precio Gasolina 95 E10 | `E10` |
| Precio Gasolina 98 E5 | `E5_98` |
| Precio Gasolina 98 E10 | `E98_E10` |
| Precio Gases licuados del petróleo, Precio Gas Licuado del Petróleo | `LPG` |
| Precio Gas Natural Comprimido | `CNG` |
| Precio Gas Natural Licuado | `LNG` |
| Precio Hidrogeno | `H2` |
| Precio Adblue | `ADBLUE` |

Things to know:

- **Numbers use a decimal comma.** Coordinates and prices both arrive as strings like `38,1234`.
- **No region is filtered out.** The coordinate check spans the Canary and Balearic Islands, Ceuta and Melilla.
- **The response is checked before use.** A reply whose `ResultadoConsulta` is not `OK`, or whose station list is empty, fails the run.

### Taiwan {#taiwan}

CPC Corporation, Taiwan's state oil company, publishes its national list prices and its station list as open data. List prices are set nationally and revised weekly.

| | |
|---|---|
| Source key | `cpc_tw` |
| Scraper | [`src/scrapers/taiwan.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/taiwan.ts) |
| Currency | TWD |
| Every | 12 h |
| API key | None |
| Licence | Open Government Data License, version 1.0 |

| CPC product | Code |
|---|---|
| 95無鉛汽油 (unleaded 95) | `E5` |
| 98無鉛汽油 (unleaded 98) | `E5_98` |
| 超級柴油 (super diesel) | `B7` |

Things to know:

- **Every station gets the list price.** The station list flags which fuels each station sells. Each flagged fuel gets the list price CPC sets for its company-owned stations. Franchise stations may sell below it.
- **Only CPC stations are covered.** Formosa Petrochemical stations are not in the feed.
- **Two grades are left out on purpose.** Regular 92 has no matching fuel code, and neither does the E3 ethanol blend.
- **Only stations marked as open are written.** The coverage includes Penghu, Kinmen and Matsu.

### United Kingdom {#united-kingdom}

Under the Competition and Markets Authority's open data scheme, large retailers each publish a JSON feed of their station prices. The scraper reads 13 of them.

| | |
|---|---|
| Source key | `cma` |
| Scraper | [`src/scrapers/uk.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/uk.ts) |
| Currency | GBP |
| Every | 4 h |
| API key | None |
| Licence | Open Government Licence v3.0 |

The feeds read are Asda, BP, Esso, Tesco, Morrisons, Sainsbury's, MFG, SGN, JET, Moto, Rontec, Ascona and Karan.

| Feed code | Code |
|---|---|
| `E10` | `E10` |
| `E5` | `E5` |
| `B7` | `B7` |
| `SDV` (super diesel) | `B7_PREMIUM` |

Things to know:

- **Shell is not included.** It publishes HTML instead of JSON.
- **Prices arrive in pence per litre.** The scraper divides by 100. Values of 900 pence or more, or 1 penny or less, are placeholders and are skipped.
- **A failing feed hides its retailer.** Each feed is fetched on its own, and a failure is logged and skipped. That retailer's stations drop off the map until a later run reads the feed again.
- **Northern Ireland is included.** Stations between 49–61° N and 11° W–2.5° E are kept.
- **The feeds carry no town field.** The town stays empty.

## Commercial and community sources {#community-sources}

### ANWB: Netherlands, Belgium, Luxembourg {#anwb}

ANWB publishes fuel stations and prices for the Netherlands, Belgium and Luxembourg through its points-of-interest API. Each country's scraper makes one request with that country's bounding box.

| | Netherlands | Belgium | Luxembourg |
|---|---|---|---|
| Source key | `anwb` | `anwb` | `anwb` |
| Scraper | [`netherlands.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/netherlands.ts) | [`belgium.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/belgium.ts) | [`luxembourg.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/luxembourg.ts) |
| Currency | EUR | EUR | EUR |
| Every | 6 h | 6 h | 12 h |
| API key | None | None | None |

| ANWB fuel | Code |
|---|---|
| `EURO95` | `E10` |
| `EURO98` | `E5_98` |
| `DIESEL` | `B7` |
| `DIESEL_SPECIAL` | `B7_PREMIUM` |
| `AUTOGAS` | `LPG` |
| `CNG` | `CNG` |

Things to know:

- **Stations are sorted by country code.** The bounding boxes overlap, so each scraper drops stations whose ISO country code belongs to another country (it keeps `NLD`, `BEL` or `LUX`). A station with no country code is kept if it falls inside the bounding box.
- **One source key, three countries.** Price replacement is scoped by country, so the three scrapers never overwrite each other.
- **The brand is guessed.** It is the first word of the station's title, which is wrong for brands with a space in their name.

### Denmark {#denmark}

FuelPrices.dk is a Danish fuel price service with a documented API. One request returns every station in Denmark with its operator and current prices.

| | |
|---|---|
| Source key | `fuelprices_dk` |
| Scraper | [`src/scrapers/denmark.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/denmark.ts) |
| Currency | DKK |
| Every | 6 h |
| API key | `FUELPRICES_DK_API_KEY`. Register at [fuelprices.dk/registrer](https://fuelprices.dk/registrer) |

FuelPrices.dk names products the way each operator does. The scraper matches the exact product name first, then any known name contained in the product name. Names that match nothing fall back to rules on the octane number and the words "diesel" and "adblue". A product that matches no rule is not imported. The four Miles names end with a full stop in the scraper's table. Without it, `Miles+95` falls through to the octane rule and is filed as `E5`.

| Product name | Code |
|---|---|
| Blyfri 95, Oktan 95, Benzin 95, Miles95., GoEasy 95 Extra E5, Shell FuelSave Blyfri 95 | `E5` |
| Blyfri 95 E10, Oktan 95 E10, 95 E10, GoEasy 95 E10 | `E10` |
| Blyfri 98, Premium 98 | `E5_98` |
| Oktan 100, Miles+95., Shell V-Power, Upgrade 95 | `E5_PREMIUM` |
| Diesel, Miles Diesel., GoEasy Diesel, Shell FuelSave Diesel | `B7` |
| Diesel+, DieselPlus, Miles+ Diesel., GoEasy Diesel Extra, Shell V-Power Diesel | `B7_PREMIUM` |
| HVO, HVO100 | `HVO` |
| LPG | `LPG` |
| CNG | `CNG` |
| AdBlue | `ADBLUE` |

Things to know:

- **Denmark only updates with a key.** Without `FUELPRICES_DK_API_KEY`, or when the key is rejected with HTTP 401, the scraper falls back to the DrivstoffAppen API. That API is retired (see [Norway](#norway)), so the fallback fails too.
- **Station ids combine operator and station.** An id looks like `dk-fp-<operator>-<station>`, so two operators can never collide.
- **The town is read from the address,** after the four-digit postcode.

### Finland {#finland}

polttoaine.net is a long-running Finnish site where drivers report prices. It has no API, so the scraper reads its HTML pages.

| | |
|---|---|
| Source key | `polttoaine` |
| Scraper | [`src/scrapers/finland.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/finland.ts) |
| Currency | EUR |
| Every | 12 h |
| API key | None |

| Column | Code |
|---|---|
| 95E10 | `E10` |
| 98E | `E5_98` |
| Diesel | `B7` |

Things to know:

- **Two passes per run.** The scraper reads 115 town, region and highway pages for names and prices. Then it opens each station's map page to read its coordinates. It pauses 100 ms between requests.
- **Stations without a map link are skipped.** Without the link there are no coordinates.
- **Prices are crowd-reported.** A station appears on several pages, and the scraper keeps the price from the last page it read.

### Greece {#greece}

FuelGR is a Greek fuel price app. The scraper queries the app's data service, which returns stations within 30 km of a point for one fuel at a time.

| | |
|---|---|
| Source key | `fuelgr` |
| Scraper | [`src/scrapers/greece.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/greece.ts) |
| Currency | EUR |
| Every | 12 h |
| API key | None |

| FuelGR fuel | Code |
|---|---|
| 1, 95 octane | `E5` |
| 2, 98–100 octane | `E5_98` |
| 4, Diesel | `B7` |
| 6, LPG | `LPG` |

Things to know:

- **Greece is covered with a grid,** islands included. The scraper queries 270 points per fuel, about 1,080 requests per run, with a 150 ms pause between requests.
- **A rate-limited point is skipped.** On HTTP 429 the scraper waits 5 seconds and moves on. Other failed points are skipped silently.
- **Responses are XML.** The price for the requested fuel sits in the station's `<ft pr="...">` element.

### Iceland {#iceland}

Gasvaktin is a community project that keeps a JSON file of every Icelandic station's current price on GitHub. It is refreshed upstream about every 15 minutes.

| | |
|---|---|
| Source key | `gasvaktin` |
| Scraper | [`src/scrapers/iceland.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/iceland.ts) |
| Currency | ISK |
| Every | 6 h |
| API key | None |
| Licence | MIT |

| Gasvaktin field | Code |
|---|---|
| `bensin95` | `E5` |
| `diesel` | `B7` |

Things to know:

- **Member-card prices are ignored.** The `*_discount` fields are loyalty prices, not the pump price.
- **The file has no street addresses.** The station name carries the place instead.

### Romania {#romania}

Peco Online is a Romanian fuel price app. The scraper reads the app's public data backend, 1,000 stations per page.

| | |
|---|---|
| Source key | `peco_online` |
| Scraper | [`src/scrapers/romania.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/romania.ts) |
| Currency | RON |
| Every | 12 h |
| API key | None |

| Peco Online field | Code |
|---|---|
| `Benzina_Regular` | `E5` |
| `Benzina_Premium` | `E5_98` |
| `Motorina_Regular` | `B7` |
| `Motorina_Premium` | `B7_PREMIUM` |
| `GPL` | `LPG` |
| `AdBlue` | `ADBLUE` |

Things to know:

- **Only stations with a regular petrol price are fetched.** The query asks for stations whose `Benzina_Regular` price is set, so a station that sells only diesel is not imported.
- **`999999` means "no price".** The scraper skips it.
- **Station ids are not unique upstream.** The same `Id` can mean two different stations, or one station listed twice. The scraper adds the coordinates to every id, in the form `Id@lat,lng`, so each station keeps a stable identity.

### Serbia {#serbia}

Serbia has no station-level price feed. The scraper combines two sources. It reads station locations and the fuels each station sells from the NIS Gazprom station map. Then it reads each brand's price per fuel from cenagoriva.rs, which lists one price per chain.

| | |
|---|---|
| Source key | `nis_cenagoriva` |
| Scraper | [`src/scrapers/serbia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/serbia.ts) |
| Currency | RSD |
| Every | 12 h |
| API key | None |

| NIS fuel | cenagoriva.rs page | Code |
|---|---|---|
| EVRO PREMIJUM BMB-95 | BMB 95 | `E5` |
| EBMB100 GDRIVE100 | BMB 100 | `E5_98` |
| EVRO DIZEL | Evro Dizel | `B7` |
| G-DRIVE DIZEL | Evro Dizel Premium | `B7_PREMIUM` |
| AUTOGAS TNG | TNG | `LPG` |

Things to know:

- **Only NIS Petrol and Gazprom Petrol stations appear.** The scraper reads locations from the NIS map only.
- **Prices are chain prices, not station prices.** Both brands take the `nis` price from cenagoriva.rs. Serbian fuel prices are regulated and close to uniform within a chain.
- **Some fuels have locations but no price.** NIS lists CNG and AdBlue, but cenagoriva.rs has no page for them, so they are not priced.
- **A failing price page drops one fuel.** It is logged and skipped, and that fuel has no prices until the next good run.

### Sweden {#sweden}

bensinpriser.nu is Sweden's long-running community price site. Its map loads every station from one bulk JSON feed, and the scraper reads that feed in one request. The site's `robots.txt` allows every path.

| | |
|---|---|
| Source key | `bensinpriser` |
| Scraper | [`src/scrapers/sweden.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/sweden.ts) |
| Currency | SEK |
| Every | 12 h |
| API key | None |

| Feed field | Code |
|---|---|
| `price95` | `E5` |
| `price98` | `E5_98` |
| `priceDiesel` | `B7` |
| `priceBiodiesel` | `HVO` |
| `priceFordonsgas` | `CNG`, priced per kg |

Things to know:

- **Two fields are dropped on purpose.** `priceLpg` repeats the ethanol price byte for byte, and Swedish forecourts sell E85, not autogas. `priceEtanol` is E85, which has no fuel code. Filing it as `E10` would show an E85 price to drivers filtering for 95-octane E10.
- **95-octane is stored as `E5`,** although Swedish 95 is an E10 blend. This matches Sweden's default fuel on the map.
- **Only recently reported stations carry a price.** Stations without a report are dropped.
- **`Övriga` means unbranded.** Those stations get no brand.
- **Old Swedish data is cleaned up automatically.** After a run with no errors and at least 200 stations, the scraper deletes Swedish prices from two retired sources, `drivstoffappen` and `bensinpriser_nu`. It then deletes the stations left with no price.

## Sources that do not work today {#unavailable-sources}

These scrapers are still in the code and still scheduled, but their sources refuse the requests. Each run fails and writes nothing, and the last prices stay on the map. [Coverage and status](coverage.md#choosing-what-runs) shows how to stop the requests.

### Fuelo.net: twelve countries {#fuelo}

Fuelo.net is a pan-European fuel price site. One shared scraper, [`src/scrapers/fuelo.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/fuelo.ts), serves twelve countries, each through its own subdomain.

**Status: paused.** Fuelo answers the station-list request with HTTP 403, and its `robots.txt` disallows the endpoint. Pumperly respects that and does not work around it. No replacement source is in place.

| Country | Scraper | Source key | Fallback currency | Every |
|---|---|---|---|---|
| Bosnia and Herzegovina | [`bosnia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/bosnia.ts) | `fuelo_ba` | BAM | 12 h |
| Bulgaria | [`bulgaria.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/bulgaria.ts) | `fuelo_bg` | EUR | 12 h |
| Czech Republic | [`czech.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/czech.ts) | `fuelo_cz` | CZK | 12 h |
| Estonia | [`estonia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/estonia.ts) | `fuelo_ee` | EUR | 12 h |
| Hungary | [`hungary.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/hungary.ts) | `fuelo_hu` | HUF | 12 h |
| Latvia | [`latvia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/latvia.ts) | `fuelo_lv` | EUR | 12 h |
| Lithuania | [`lithuania.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/lithuania.ts) | `fuelo_lt` | EUR | 12 h |
| North Macedonia | [`north-macedonia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/north-macedonia.ts) | `fuelo_mk` | MKD | 12 h |
| Poland | [`poland.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/poland.ts) | `fuelo_pl` | PLN | 12 h |
| Slovakia | [`slovakia.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/slovakia.ts) | `fuelo_sk` | EUR | 12 h |
| Switzerland | [`switzerland.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/switzerland.ts) | `fuelo_ch` | CHF | 12 h |
| Turkey | [`turkey.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/turkey.ts) | `fuelo_tr` | TRY | 12 h |

When the source answers, a run works in two phases. First, one request lists every station id and position inside the country's bounding box. Then one request per station reads its name, address and prices, with a short pause after every five stations. Station ids take the form `fuelo_<id>`, and the brand comes from the station's logo name.

Fuelo marks each fuel with an icon. The scraper maps the icon's file name:

| Fuelo icon | Code |
|---|---|
| `gasoline.png` | `E5` |
| `gasoline95plus.png` | `E5_PREMIUM` |
| `gasoline98.png`, `gasoline98plus.png` (100 octane) | `E5_98` |
| `diesel.png` | `B7` |
| `dieselplus.png` | `B7_PREMIUM` |
| `lpg.png` | `LPG` |
| `methane.png`, `cng.png` | `CNG` |
| `lng.png` | `LNG` |
| `adblue.png` | `ADBLUE` |

Things to know:

- **The currency comes from each price label,** such as `563,8 HUF/l` or `1,42 €/l`. The fallback currency applies only when the label shows none the scraper recognises.
- **A lone dot is ambiguous.** In `1.518`, the dot is a decimal point for EUR, GBP, CHF, BGN, BAM, PLN and RON, and a thousands separator for every other currency. For HUF, `1.518` means 1518. The per-currency price check catches a misread value.

### Ireland {#ireland}

Pick A Pump is an Irish price site where drivers report prices.

| | |
|---|---|
| Source key | `pickapump` |
| Scraper | [`src/scrapers/ireland.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/ireland.ts) |
| Currency | EUR |
| Every | 12 h |
| API key | None |

**Status: blocked.** Pick A Pump rejects scrapers with HTTP 403, and its `robots.txt` disallows them. No open alternative source exists.

When the source answers, the scraper queries about 120 points on a grid with a 20 km radius, 150 ms apart. It keeps stations in the Republic of Ireland only. Northern Ireland comes from the [United Kingdom](#united-kingdom) feeds.

| Pick A Pump field | Code |
|---|---|
| `petrol` | `E10` |
| `petrolplus` | `E5_98` |
| `diesel` | `B7` |
| `dieselplus` | `B7_PREMIUM` |
| `hvo` | `HVO` |

Prices arrive in euro cents per litre, and the scraper divides by 100. Irish standard unleaded is E10, so `petrol` maps to `E10`.

### Norway {#norway}

DrivstoffAppen was Norway's main fuel price aggregator. It built on the country's mandatory real-time price reporting.

| | |
|---|---|
| Source key | `drivstoffappen` |
| Scraper | [`src/scrapers/norway.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/norway.ts) |
| Currency | NOK |
| Every | 6 h |
| API key | None |

**Status: down.** The public API is retired. The endpoint that issued session tokens answers HTTP 404, and its successor requires authorisation that is not publicly available. The scraper still sends that one request each run, so Norway recovers on its own if the public API returns.

No replacement is adopted. The alternatives either forbid scraping, require credentials meant only for their own apps, or publish data that does not hold up. Statistics Norway publishes national monthly averages, not station prices.

When the source answers, the scraper maps these fuels:

| DrivstoffAppen fuel | Code |
|---|---|
| 1, Diesel | `B7` |
| 2, 95 Oktan | `E5` |
| 3, 98 Oktan | `E5_98` |
| 4, Frigårdsdiesel (farm diesel) | `B7` |
| 7, HVO 100 | `HVO` |
| 9, E-85 | `E10` |
