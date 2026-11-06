# Pumperly

![Pumperly](<https://geiserx.github.io/Pumperly/images/banner.svg>)

[![Live at pumperly.com](<https://img.shields.io/badge/live-pumperly.com-34d399?style=flat-square>)](<https://pumperly.com>) [![Docker Pulls](<https://img.shields.io/docker/pulls/drumsergio/pumperly?style=flat-square&amp;logo=docker>)](<https://hub.docker.com/r/drumsergio/pumperly>) [![GitHub Stars](<https://img.shields.io/github/stars/GeiserX/Pumperly?style=flat-square&amp;logo=github>)](<https://github.com/GeiserX/Pumperly/stargazers>) [![Release](<https://img.shields.io/github/v/release/GeiserX/Pumperly?style=flat-square>)](<https://github.com/GeiserX/Pumperly/releases>) [![License: AGPL-3.0-or-later](<https://img.shields.io/github/license/GeiserX/Pumperly?style=flat-square>)](<https://github.com/GeiserX/Pumperly/blob/main/LICENSE>)

---

**Pumperly** is an open-source map of fuel prices and EV chargers with a route planner on top. Pick a destination and it draws the route, lists every station along it with its price and the minutes a stop would add, and plans the cheapest places to fill up. Prices come straight from government and community sources in 22 countries, with no key to set. Use it at [pumperly.com](<https://pumperly.com>) or [run your own copy with Docker Compose](<https://geiserx.github.io/Pumperly/getting-started/docker-compose/index.md>) and read [Planning a route](<https://geiserx.github.io/Pumperly/using/routes/index.md>) to see what it does with a trip.

[Open pumperly.com](<https://pumperly.com>) [Run it yourself](<https://geiserx.github.io/Pumperly/getting-started/docker-compose/index.md>)

- **[Run with Docker Compose](<https://geiserx.github.io/Pumperly/getting-started/docker-compose/index.md>)**

  ---

  Start PostGIS and the app with the shipped compose file and open the map on port 3000.
- **[What happens on first start](<https://geiserx.github.io/Pumperly/getting-started/first-start/index.md>)**

  ---

  Watch the scrapers fill the map country by country, and check that it worked.
- **[Planning a route](<https://geiserx.github.io/Pumperly/using/routes/index.md>)**

  ---

  Stations along your trip, the detour each one costs, and the cheapest fuel stops planned for you.
- **[Environment variables](<https://geiserx.github.io/Pumperly/reference/environment-variables/index.md>)**

  ---

  Every setting, its default and what it changes.

## The map and the route

Each dot is a station, coloured by its price for the fuel you picked: green is the cheapest 5% on screen, purple the most expensive. See [The map](<https://geiserx.github.io/Pumperly/using/map/index.md>).

![The Pumperly map over Lisbon on the diesel layer. Stations are coloured from green to purple by price, with the price legend and the max-price slider in the bottom-left corner.](<https://geiserx.github.io/Pumperly/images/screenshots/map.png>)

Plan a route and the side panel lists the stations along it, sorted by price, detour or position. The max-detour slider hides the ones that cost more minutes than you allow. See [Planning a route](<https://geiserx.github.io/Pumperly/using/routes/index.md>).

![A diesel route from Lisbon to Porto. The side panel lists the stations along it with their prices, the extra minutes each one adds and the Cheapest and Balanced badges.](<https://geiserx.github.io/Pumperly/images/screenshots/route-stations.png>)

Open **Plan fuel stops**, give it your tank size, consumption and how full you start, and it picks the cheapest stops that get you there. The stops are numbered on the map. Added in v1.15.0.

![The refuel planner open under the same route. It proposes one numbered stop near Lisbon, shows the fuel level before and after it, and the total fuel cost for the trip.](<https://geiserx.github.io/Pumperly/images/screenshots/route-planner.png>)

![The map on a phone, with the fuel selector in the top bar and the legend at the bottom](<https://geiserx.github.io/Pumperly/images/screenshots/map-mobile.png>)

On a phone

![The route on a phone. The station list sits in a sheet at the bottom of the screen, opened halfway](<https://geiserx.github.io/Pumperly/images/screenshots/route-mobile.png>)

Stations in the bottom sheet

![The map on a phone in dark mode, with the dark map style and the same price colours](<https://geiserx.github.io/Pumperly/images/screenshots/map-dark-mobile.png>)

Dark mode

## What it shows

- Fuel stations with their latest prices for the fuel you choose: diesel, petrol, LPG, CNG, LNG, hydrogen, HVO and AdBlue. See [Fuel types](<https://geiserx.github.io/Pumperly/reference/fuel-types/index.md>).
- Live prices from 22 countries with no key to set, and from two more with a free key. 39 countries are supported in all; [Coverage and status](<https://geiserx.github.io/Pumperly/data/coverage/index.md>) lists each one, its source and whether the source works today.
- EV chargers from the official registries of Spain and Germany and from [Open Charge Map](<https://openchargemap.org>) elsewhere. See [EV charging](<https://geiserx.github.io/Pumperly/using/ev-charging/index.md>).
- A station's popup: brand, address, price, when it was last updated, directions, and a link to share. See [Station popup](<https://geiserx.github.io/Pumperly/using/map/#station-popup>).
- Routes with up to five stops and up to three alternatives, when Valhalla is configured; address search as you type, when Photon is configured.
- Prices in any of 37 currencies, converted with the European Central Bank's daily rates; the interface in 17 languages. See [Currencies and exchange rates](<https://geiserx.github.io/Pumperly/reference/currencies/index.md>).
- Share links for a station or a route. See [Share links and deep links](<https://geiserx.github.io/Pumperly/using/links/index.md>).
- A small [HTTP API](<https://geiserx.github.io/Pumperly/reference/api/index.md>) for stations, routes and statistics, used by the [related projects](<https://geiserx.github.io/Pumperly/related/index.md>).

## How it runs

```
flowchart LR
    subgraph sources [Price and charger sources]
        GOV[Government open data]
        COM[Community and commercial feeds]
        OCM[Open Charge Map and national EV registries]
    end
    subgraph app [Pumperly app container, port 3000]
        SCH[Scheduler<br/>one timer per scraper]
        SCR[Scrapers]
        API[Next.js pages and API]
    end
    DB[(PostGIS<br/>stations and prices)]
    VAL[Valhalla<br/>routing, optional]
    PHO[Photon<br/>address search, optional]
    ECB[ECB daily exchange rates]
    TILES[OpenFreeMap<br/>map tiles]
    BR[Browser map]

    SCH --> SCR
    GOV --> SCR
    COM --> SCR
    OCM --> SCR
    SCR --> DB
    DB --> API
    API -.-> VAL
    API -.-> PHO
    API -.-> ECB
    API <--> BR
    TILES --> BR
```

- One Next.js process serves the map, answers the API and runs every scraper on its own timer. See [How scrapers work](<https://geiserx.github.io/Pumperly/data/how-scrapers-work/index.md>).
- The image is `drumsergio/pumperly` on Docker Hub, for linux/amd64 and linux/arm64. It listens on port 3000 and runs as user id 1001.
- Scrapers write to PostGIS. The map, the route list and the stats read from it.
- Routes need [Valhalla](<https://geiserx.github.io/Pumperly/configuration/routing-valhalla/index.md>) and address search needs [Photon](<https://geiserx.github.io/Pumperly/configuration/geocoding-photon/index.md>). Without them the map and its prices still work. [Full stack with routing and geocoding](<https://geiserx.github.io/Pumperly/getting-started/full-stack/index.md>) runs all of it.
- Run one copy of the app per database. Two copies would scrape every source twice.

## What it does not do

- It has EV charging prices for Germany only. Elsewhere the sources publish charger locations, not tariffs.
- It has no fuel prices for the United States, only chargers. No national price feed exists.
- It does not route without Valhalla, and its search box finds nothing without Photon. The shipped compose file starts neither.
- It does not store prices for a paused or blocked source. The last good prices stay on the map, and each popup says how old they are.

## Privacy

- No accounts, no cookies for tracking, no analytics. The only cookie remembers your language. Your currency and theme are saved in the browser, not on the server.
- Your position is used to centre the map and to fill in "My location" as the start of a route. It is sent to the server only as the start point of a route you ask for.
- Address searches go to the Photon server the operator configured, and routes to the Valhalla server. On pumperly.com both are self-hosted.
- The map tiles load from [OpenFreeMap](<https://openfreemap.org>), which sees your tile requests like any map site.

## Getting help

- New here? Start with [Run with Docker Compose](<https://geiserx.github.io/Pumperly/getting-started/docker-compose/index.md>), then [What happens on first start](<https://geiserx.github.io/Pumperly/getting-started/first-start/index.md>).
- If something is broken, read [Monitoring and troubleshooting](<https://geiserx.github.io/Pumperly/operations/troubleshooting/index.md>), then open an [issue on GitHub](<https://github.com/GeiserX/Pumperly/issues>).
- To report a security problem, follow the [security policy](<https://github.com/GeiserX/Pumperly/blob/main/SECURITY.md>) and do not open a public issue.
- The [Glossary](<https://geiserx.github.io/Pumperly/reference/glossary/index.md>) explains the terms these pages use.
- Home Assistant, AI assistants over MCP and n8n connect through the [related projects](<https://geiserx.github.io/Pumperly/related/index.md>).
- To add a country or send a fix, read [Adding a country](<https://geiserx.github.io/Pumperly/data/adding-a-country/index.md>) and [Development](<https://geiserx.github.io/Pumperly/development/index.md>).

## All pages

- Get started: [Run with Docker Compose](<https://geiserx.github.io/Pumperly/getting-started/docker-compose/index.md>) · [What happens on first start](<https://geiserx.github.io/Pumperly/getting-started/first-start/index.md>) · [Full stack with routing and geocoding](<https://geiserx.github.io/Pumperly/getting-started/full-stack/index.md>) · [Run on Kubernetes with Helm](<https://geiserx.github.io/Pumperly/getting-started/kubernetes/index.md>)
- Using Pumperly: [The map](<https://geiserx.github.io/Pumperly/using/map/index.md>) · [Planning a route](<https://geiserx.github.io/Pumperly/using/routes/index.md>) · [EV charging](<https://geiserx.github.io/Pumperly/using/ev-charging/index.md>) · [Share links and deep links](<https://geiserx.github.io/Pumperly/using/links/index.md>)
- Data sources: [Coverage and status](<https://geiserx.github.io/Pumperly/data/coverage/index.md>) · [Sources at a glance](<https://geiserx.github.io/Pumperly/data/sources-at-a-glance/index.md>) · [Fuel price sources](<https://geiserx.github.io/Pumperly/data/fuel-sources/index.md>) · [EV charging sources](<https://geiserx.github.io/Pumperly/data/ev-sources/index.md>) · [How scrapers work](<https://geiserx.github.io/Pumperly/data/how-scrapers-work/index.md>) · [Adding a country](<https://geiserx.github.io/Pumperly/data/adding-a-country/index.md>)
- Configuration: [Countries and scrape schedule](<https://geiserx.github.io/Pumperly/configuration/countries-and-schedule/index.md>) · [Routing with Valhalla](<https://geiserx.github.io/Pumperly/configuration/routing-valhalla/index.md>) · [Geocoding with Photon](<https://geiserx.github.io/Pumperly/configuration/geocoding-photon/index.md>) · [API keys](<https://geiserx.github.io/Pumperly/configuration/api-keys/index.md>)
- Operations: [Upgrading](<https://geiserx.github.io/Pumperly/operations/upgrading/index.md>) · [Backing up the database](<https://geiserx.github.io/Pumperly/operations/backup-and-restore/index.md>) · [Monitoring and troubleshooting](<https://geiserx.github.io/Pumperly/operations/troubleshooting/index.md>)
- Reference: [Environment variables](<https://geiserx.github.io/Pumperly/reference/environment-variables/index.md>) · [HTTP API](<https://geiserx.github.io/Pumperly/reference/api/index.md>) · [Data model](<https://geiserx.github.io/Pumperly/reference/data-model/index.md>) · [Fuel types](<https://geiserx.github.io/Pumperly/reference/fuel-types/index.md>) · [Currencies and exchange rates](<https://geiserx.github.io/Pumperly/reference/currencies/index.md>) · [Glossary](<https://geiserx.github.io/Pumperly/reference/glossary/index.md>)
- Project: [Roadmap](<https://geiserx.github.io/Pumperly/roadmap/index.md>) · [Related projects](<https://geiserx.github.io/Pumperly/related/index.md>) · [Development](<https://geiserx.github.io/Pumperly/development/index.md>)

## License

Pumperly is released under the [AGPL-3.0-or-later](<https://github.com/GeiserX/Pumperly/blob/main/LICENSE>) license. Price and charger data keep the licence of their source; [Fuel price sources](<https://geiserx.github.io/Pumperly/data/fuel-sources/index.md>) and [EV charging sources](<https://geiserx.github.io/Pumperly/data/ev-sources/index.md>) list them, and some allow only non-commercial use. If you run a public instance, read [Data licences on a public instance](<https://geiserx.github.io/Pumperly/getting-started/docker-compose/#data-licences-on-a-public-instance>) first.
