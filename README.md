<p align="center">
  <img src="https://raw.githubusercontent.com/GeiserX/Pumperly/main/docs/images/banner.svg" alt="Pumperly banner" width="900"/>
</p>

<h1 align="center">Pumperly</h1>

<p align="center">
  <strong>Open-source fuel and EV route planner with live prices from 22 countries. Self-hostable.</strong>
</p>

<p align="center">
  <a href="https://github.com/GeiserX/Pumperly/releases"><img src="https://img.shields.io/github/v/release/GeiserX/Pumperly?style=flat-square" alt="Release"></a>
  <a href="https://github.com/GeiserX/Pumperly/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/GeiserX/Pumperly/ci.yml?style=flat-square&logo=github&label=CI" alt="CI"></a>
  <a href="https://github.com/GeiserX/Pumperly/blob/main/LICENSE"><img src="https://img.shields.io/github/license/GeiserX/Pumperly?style=flat-square" alt="License"></a>
  <a href="https://hub.docker.com/r/drumsergio/pumperly"><img src="https://img.shields.io/docker/pulls/drumsergio/pumperly?style=flat-square&logo=docker&label=Docker%20Pulls" alt="Docker Pulls"></a>
  <a href="https://geiserx.github.io/Pumperly/"><img src="https://img.shields.io/badge/docs-geiserx.github.io%2FPumperly-34d399?style=flat-square&logo=materialformkdocs&logoColor=white" alt="Documentation"></a>
</p>

Pumperly is a map of fuel prices and EV chargers with a route planner on top. Pick a destination and it draws the route, lists every station along it with its price and the minutes a stop would add, and plans the cheapest places to fill up. Prices come from government and community sources in 22 countries with no key to set. **Try it at [pumperly.com](https://pumperly.com)**, or run your own copy with Docker Compose.

<p align="center">
  <img src="https://raw.githubusercontent.com/GeiserX/Pumperly/main/docs/images/screenshots/route-planner.png" alt="A diesel route from Lisbon to Porto with the refuel planner open: one numbered stop on the map, the fuel level before and after it, and the total fuel cost" width="900"/>
</p>

## Features

- Shows every station on the map coloured by price, green for the cheapest 5% on screen to purple for the most expensive.
- Lists the stations along your route with the extra minutes each one costs, and hides the ones past the detour you allow.
- Plans the cheapest fuel stops for the trip from your tank size, consumption and how full you start.
- Keeps prices fresh from 22 countries with no API key, and from two more with a free key. Supports 39 countries in all, each listed with its status.
- Shows EV chargers from the official registries of Spain and Germany and from Open Charge Map everywhere else.
- Converts prices into 37 currencies with the European Central Bank's daily rates, and speaks 17 languages.
- Makes any station or route a link you can share.
- Runs as one container next to PostGIS, with Valhalla and Photon optional, and keeps no accounts, no analytics and no tracking cookies.

## Quick start

```bash
git clone https://github.com/GeiserX/Pumperly.git && cd Pumperly && cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
```

Open `http://localhost:3000`. The map fills country by country over the next few minutes as the scrapers run. This first run has the price map only: routes and address search need Valhalla and Photon, which [Full stack with routing and geocoding](https://geiserx.github.io/Pumperly/getting-started/full-stack/) adds. [Run with Docker Compose](https://geiserx.github.io/Pumperly/getting-started/docker-compose/) explains the settings in `.env`.

## Documentation

The full documentation lives at **[geiserx.github.io/Pumperly](https://geiserx.github.io/Pumperly/)**.

- [Run with Docker Compose](https://geiserx.github.io/Pumperly/getting-started/docker-compose/): the shipped compose file, the settings in `.env`, and what to do before exposing it.
- [What happens on first start](https://geiserx.github.io/Pumperly/getting-started/first-start/): the scrapers, their timetable, and how to check that it worked.
- [Full stack with routing and geocoding](https://geiserx.github.io/Pumperly/getting-started/full-stack/): Valhalla and Photon, with the compose file that runs all of it.
- [The map](https://geiserx.github.io/Pumperly/using/map/) and [Planning a route](https://geiserx.github.io/Pumperly/using/routes/): every control, the price colours, detours and the refuel planner.
- [Coverage and status](https://geiserx.github.io/Pumperly/data/coverage/): every country, its source and whether it works today.
- [Environment variables](https://geiserx.github.io/Pumperly/reference/environment-variables/) and the [HTTP API](https://geiserx.github.io/Pumperly/reference/api/).

## Related projects

[pumperly-mcp](https://github.com/GeiserX/pumperly-mcp) (MCP server), [pumperly-ha](https://github.com/GeiserX/pumperly-ha) (Home Assistant), [n8n-nodes-pumperly](https://github.com/GeiserX/n8n-nodes-pumperly) (n8n node, archived). Also listed on [awesome-europe](https://github.com/GeiserX/awesome-europe#readme) and [ArtifactHub](https://artifacthub.io/packages/helm/pumperly/pumperly).

## License

[AGPL-3.0-or-later](https://github.com/GeiserX/Pumperly/blob/main/LICENSE). If you run a modified version as a network service, you must offer its source code to the users of that service.
