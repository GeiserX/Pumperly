# Roadmap

This page describes where Pumperly is going: what works today, and what it does not do yet. Entries have no dates and no target versions, and none is promised for a particular release. The full working plan, with every phase and checklist, is [ROADMAP.md](https://github.com/GeiserX/Pumperly/blob/main/ROADMAP.md) in the repository.

The goal is one route planner for every kind of vehicle: petrol, diesel, gas, hydrogen and electric. It should find the cheapest place to refuel or recharge along any route and tell you whether the detour is worth it.

## Where the project is now

The plan has eight phases, numbered 0 to 7. Phases 0 to 3 are in place:

| Phase | What it covers | State |
| --- | --- | --- |
| 0. Foundation | Map, database, first scraper, geolocation | Done |
| 1. Route planning | Valhalla routes, Photon search, waypoints, alternative routes, stations along the route | Done |
| 2. Smart features | Detour time per station, the "cheapest within N minutes" filter | Done, except refuelling by range and the faster detour calculation |
| 3. Multi-country | Scraper framework, many countries, cross-border routing, languages | Done, with gaps listed below |
| 4. Polish and UX | Mobile layout, dark mode, station pages, offline use | Partly done |
| 5. EV charging | Charger data, EV route planning | Charger locations done; connector details and EV route planning not started |
| 6. Community | Crowdsourced prices, price alerts, a public developer API | Not started |
| 7. Global expansion | More countries in and outside Europe | Under way |

What works today is described in [The map](using/map.md), [Planning a route](using/routes.md) and [EV charging](using/ev-charging.md). Which countries have data, and which sources are down, is on [Coverage and status](data/coverage.md).

## Routes and refuelling

- **Refuel by remaining range.** You enter how far your tank or battery still reaches, and Pumperly recommends where to stop. It favours stops in the middle of your range and never suggests one you might not reach. Today you pick the stop yourself, using the detour filter and the price difference against the route average.
- **Faster detour calculation.** Detours come from one Valhalla matrix request instead of one route per station. Today `/api/route-detour` asks Valhalla for a separate route for each station and streams results as they arrive. It takes at most 150 stations per request, or fewer when `PUMPERLY_MAX_DETOUR_STATIONS` is set lower.
- **Trip fuel cost.** A saved vehicle profile (tank size, consumption) turns a route into an estimated fuel cost. Today there is no vehicle profile.

## EV charging

- **EV route planning.** You enter battery size, charge level and consumption, and Pumperly plans the charging stops. Today EV chargers show on the map and along a route, like fuel stations, without range planning.
- **Connector, power and price details.** Each charger shows its connector types, power in kW and price per kWh. Today a charger is stored like any station, with its location, name, brand and address, and none of these fields.
- **More official registries.** National registries replace crowdsourced data in more countries. Today Spain (Mapa REVE, with an API key) and Germany (the BNetzA Ladesäulenregister) use official registries, and every other country uses Open Charge Map. See [EV charging sources](data/ev-sources.md).

## Coverage

- **Station prices where the source is gone.** Several countries have no working source today. The countries served through Fuelo.net get no new prices because Fuelo.net refuses the requests the scraper makes. Ireland's source rejects scrapers, Norway's public API was retired, and Argentina's source does not answer requests from Europe. Pumperly does not work around a block. A country comes back only when a source that allows it exists. See [Coverage and status](data/coverage.md).
- **Fuel prices in the United States.** There is no national open fuel-price source, so the United States has EV chargers only.
- **More countries.** New countries arrive one scraper at a time. [Adding a country](data/adding-a-country.md) explains how to contribute one, including the static data path for places with no API.

## Using the app

- **A page per station.** Each station gets its own page with its prices and a price history chart. Today a station is a pin on the map with a popup, and a row in the route list. The popup already links to directions in Google Maps.
- **Offline use.** The app keeps working without a connection, with the last known prices. Today the app ships a web manifest but no service worker, so it needs a connection.
- **Border price hints.** Near a border, Pumperly tells you when fuel is cheaper on the other side. Today you can show prices in one currency, converted with daily European Central Bank rates, or a fixed approximate rate for the few currencies the bank does not publish. Nothing points out the difference.

## Community and developers

- **Crowdsourced price reports.** Anyone can report a price at a station, without an account, to correct stale official data.
- **Price alerts.** A notification when a fuel drops below a price you set in your area. Today the [Home Assistant integration](related.md#pumperly-ha) can do this with an automation.
- **A versioned public API.** A stable `/api/v1` with an OpenAPI description. Today the [HTTP API](reference/api.md) is unversioned and serves the web app first.

## Operations

- **Scraper health reporting.** Each scraper reports its last good run, station count and error rate. Today `/api/stats` gives the time of the newest price per country, and failures appear in the logs. See [Monitoring and troubleshooting](operations/troubleshooting.md).
- **Scheduled Valhalla tile rebuilds.** Routing tiles rebuild on a schedule from fresh OpenStreetMap data. Today a rebuild is manual. See [Routing with Valhalla](configuration/routing-valhalla.md).

## Suggest a feature

Search the [open issues](https://github.com/GeiserX/Pumperly/issues) first, then open one if your idea is not there. To build it yourself, read [Development](development.md).

## Recently shipped

- **1.14.0:** Taiwan and Cyprus, from their official open price data.
- **1.13.0:** German EV chargers come from the BNetzA Ladesäulenregister instead of Open Charge Map.
- **1.12.0:** Spanish EV chargers can come from the official Mapa REVE registry.
- **1.11.0:** A Catalan translation.
- **1.10.0:** EV chargers across the United States, from Open Charge Map.

The [releases page](https://github.com/GeiserX/Pumperly/releases) lists every version.
