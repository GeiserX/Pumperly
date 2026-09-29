# Features at a glance

## What is Pumperly?

Pumperly combines route planning with real-time fuel prices and EV charging station data. No other open-source tool does this.

- Plan a route from A to B with autocomplete and alternative routes
- See every fuel station and EV charger within a corridor along your route
- Filter by "cheapest within N minutes detour" — the feature no competitor has
- Covers 39 fuel-price countries across Europe, Latin America, Asia and Oceania, plus US EV-charger coverage (stations only — no national fuel-price API exists)
- 17 languages, 37 currencies, fully self-hostable
- 100% open source (AGPL-3.0-or-later), no tracking, no cookies, no accounts

## Features

- **Route planning** — Geocoding via [Photon](https://github.com/komoot/photon), routing via [Valhalla](https://github.com/valhalla/valhalla), with alternative routes
- **Real-time fuel prices** — From government open data APIs and community sources
- **EV charging stations** — Official registries where they exist ([Mapa REVE](https://www.mapareve.es) in Spain, the [BNetzA Ladesäulenregister](https://www.bundesnetzagentur.de/DE/Fachthemen/ElektrizitaetundGas/E-Mobilitaet/Ladesaeulenkarte/start.html) in Germany), [Open Charge Map](https://openchargemap.org) everywhere else
- **Detour calculation** — Each station shows estimated detour time from your route
- **"Cheapest within N min"** — Slider filters stations by maximum detour, highlights the best deal
- **Corridor station list** — Sorted by position along route, with price deltas vs average
- **Price color scale** — Green (cheap) to red (expensive) based on P5/P95 percentiles
- **Station clustering** — GPU-accelerated clustering at low zoom levels
- **17 languages** — ES, EN, FR, DE, IT, PT, PL, CS, HU, BG, SK, DA, SV, NO, SR, FI, CA
- **37 currencies** — from EUR, GBP and CHF to ARS, MXN and TWD. See [Currencies and exchange rates](reference/currencies.md)
- **Geolocation** — Auto-centers on your location with one tap
- **Privacy-first** — No cookies, no analytics, no personal data collection

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | [Next.js](https://nextjs.org) 16, [React](https://react.dev) 19, [MapLibre GL JS](https://maplibre.org), [Tailwind CSS](https://tailwindcss.com) |
| Backend | Next.js API routes, [Prisma](https://prisma.io) ORM |
| Database | [PostGIS](https://postgis.net) 17 (PostgreSQL + spatial) |
| Routing | [Valhalla](https://github.com/valhalla/valhalla) 3.5.1 |
| Geocoding | [Photon](https://github.com/komoot/photon) 1.0.1 |
| Map tiles | [OpenFreeMap](https://openfreemap.org) (OpenStreetMap) |
| Deployment | Docker, GitHub Actions CI/CD |
