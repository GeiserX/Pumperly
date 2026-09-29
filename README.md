<p align="center">
  <img src="https://raw.githubusercontent.com/GeiserX/Pumperly/main/docs/images/banner.svg" alt="Pumperly banner" width="900"/>
</p>

<br>

<h1 align="center">Pumperly</h1>

<p align="center">
  <strong>Open-source fuel &amp; EV route planner. Real-time prices across 39 countries. Self-hostable.</strong>
</p>

<p align="center">
  <a href="https://github.com/GeiserX/Pumperly/releases"><img src="https://img.shields.io/github/v/release/GeiserX/Pumperly?style=flat-square" alt="Release"></a>
  <a href="https://github.com/GeiserX/Pumperly/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/GeiserX/Pumperly/ci.yml?style=flat-square&logo=github&label=CI" alt="CI"></a>
  <a href="https://github.com/GeiserX/Pumperly/blob/main/LICENSE"><img src="https://img.shields.io/github/license/GeiserX/pumperly?style=flat-square" alt="License"></a>
  <a href="https://hub.docker.com/r/drumsergio/pumperly"><img src="https://img.shields.io/docker/pulls/drumsergio/pumperly?style=flat-square&logo=docker&label=Docker%20Pulls" alt="Docker Pulls"></a>
  <a href="https://geiserx.github.io/Pumperly/"><img src="https://img.shields.io/badge/docs-geiserx.github.io%2FPumperly-22c55e?style=flat-square&logo=materialformkdocs&logoColor=white" alt="Documentation"></a>
</p>

<br>

<p align="center">
  <img src="https://raw.githubusercontent.com/GeiserX/Pumperly/main/docs/images/screenshot-route.png" alt="Route planning — Huelva to Girona with fuel stations along the corridor" width="900"/>
</p>

---

Pumperly combines route planning with real-time fuel prices and EV charging station data. Plan a route, see every fuel station and EV charger along it, and filter by "cheapest within N minutes detour". **Try it now at [pumperly.com](https://pumperly.com)**, or self-host it with Docker Compose.

## Features

- **Route planning** — geocoding via [Photon](https://github.com/komoot/photon), routing via [Valhalla](https://github.com/valhalla/valhalla), with alternative routes
- **Real-time fuel prices** — 36 fuel-price countries across Europe, Latin America, and Oceania, from government open data and community sources
- **EV charging stations** — official registries in Spain ([Mapa REVE](https://www.mapareve.es)) and Germany (BNetzA Ladesäulenregister), [Open Charge Map](https://openchargemap.org) everywhere else, plus US chargers
- **"Cheapest within N min"** — each station shows its detour time; a slider filters by maximum detour and highlights the best deal
- **Corridor station list** — sorted by position along the route, with price deltas vs average and a green-to-red price scale
- **16 languages and 16 currencies**, with GPU-accelerated station clustering and one-tap geolocation
- **Privacy-first** — no cookies, no analytics, no accounts, no personal data collection
- **Self-hostable** — Docker Compose or a Helm chart; Valhalla and Photon are optional

## Quick start

```bash
git clone https://github.com/GeiserX/pumperly.git && cd pumperly && cp .env.example .env
docker compose -f docker/docker-compose.yml up -d
```

Open `http://localhost:3000` once all services are healthy. [Run with Docker Compose](https://geiserx.github.io/Pumperly/getting-started/docker-compose/) walks through the setup. Routing tiles and the geocoding index take hours to build on first start; the [full stack page](https://geiserx.github.io/Pumperly/getting-started/full-stack/) has the details.

## Documentation

The full documentation lives at **[geiserx.github.io/Pumperly](https://geiserx.github.io/Pumperly/)**.

- [Features at a glance](https://geiserx.github.io/Pumperly/features/) · [Sources at a glance](https://geiserx.github.io/Pumperly/data/sources-at-a-glance/)
- [Run with Docker Compose](https://geiserx.github.io/Pumperly/getting-started/docker-compose/) · [Full stack with routing and geocoding](https://geiserx.github.io/Pumperly/getting-started/full-stack/) · [What happens on first start](https://geiserx.github.io/Pumperly/getting-started/first-start/) · [Kubernetes with Helm](https://geiserx.github.io/Pumperly/getting-started/kubernetes/) · [Local development](https://geiserx.github.io/Pumperly/getting-started/development/)
- [Coverage and status](https://geiserx.github.io/Pumperly/data/coverage/) · [Fuel price sources](https://geiserx.github.io/Pumperly/data/fuel-sources/) · [EV charging sources](https://geiserx.github.io/Pumperly/data/ev-sources/)
- [Routing with Valhalla](https://geiserx.github.io/Pumperly/configuration/routing-valhalla/) · [Geocoding with Photon](https://geiserx.github.io/Pumperly/configuration/geocoding-photon/) · [API keys](https://geiserx.github.io/Pumperly/configuration/api-keys/)
- [Environment variables](https://geiserx.github.io/Pumperly/reference/environment-variables/) · [HTTP API](https://geiserx.github.io/Pumperly/reference/api/) · [Roadmap](https://geiserx.github.io/Pumperly/roadmap/) · [Contributing](https://geiserx.github.io/Pumperly/contributing/)

## Ecosystem

[pumperly-mcp](https://github.com/GeiserX/pumperly-mcp) (MCP server), [pumperly-ha](https://github.com/GeiserX/pumperly-ha) (Home Assistant), [n8n-nodes-pumperly](https://github.com/GeiserX/n8n-nodes-pumperly) (n8n node). Also listed on [awesome-europe](https://github.com/GeiserX/awesome-europe#readme) and [ArtifactHub](https://artifacthub.io/packages/helm/pumperly/pumperly).

## License

[AGPL-3.0-or-later](https://github.com/GeiserX/Pumperly/blob/main/LICENSE) — free to use, modify, and distribute. If you distribute a modified version, you must give its source code, under the same license, to the people who receive it. If you run a modified version as a network service, you must offer its source code to the users of that service (AGPL section 13).

---

<p align="center">
  Made by <a href="https://github.com/GeiserX">Sergio Fernandez</a>
</p>
