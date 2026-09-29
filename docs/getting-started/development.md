# Local development

This page sets up a checkout for working on Pumperly: the database, the dev server, the scraper command line and the tests. To run Pumperly rather than change it, use [Run with Docker Compose](docker-compose.md).

## What you need

- Node.js 22. CI and the Docker image both use it.
- npm. The repository ignores other package managers' lockfiles, so `package-lock.json` is the only one.
- Docker, for PostGIS and for the integration tests.

## Set up a checkout

### 1. Clone and install

```bash
git clone https://github.com/GeiserX/Pumperly.git
cd Pumperly
npm ci
cp .env.example .env
```

`npm ci` installs exactly what `package-lock.json` lists, as CI does.

### 2. Point `.env` at the local database

The `DATABASE_URL` in `.env.example` names the host `pumperly-db`, which only resolves inside Docker. From your machine, the shipped compose file publishes PostGIS on port 5433. Change the line to:

```ini
DATABASE_URL=postgresql://pumperly:pumperly@localhost:5433/pumperly
```

Two more lines keep a dev session small:

```ini
PUMPERLY_ENABLED_COUNTRIES=ES
PUMPERLY_SCRAPE_INTERVAL_HOURS=0
```

The dev server runs the same scheduler as production. The first line limits it to one country. The second turns it off, so nothing scrapes until you run the command line yourself. See [What happens on first start](first-start.md#the-scheduler).

### 3. Start PostGIS

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts only the database. See [What the shipped compose file runs](docker-compose.md#what-the-shipped-compose-file-runs).

### 4. Generate the Prisma client and create the schema

```bash
npx prisma generate
npx prisma migrate deploy
```

- `prisma generate` writes the typed database client to `src/generated/prisma`. Git ignores that directory, so every fresh checkout needs this step. The tests and the build need it too.
- `prisma migrate deploy` applies the SQL files under `prisma/migrations` and records them. It reads `DATABASE_URL` from `.env` through [`prisma.config.ts`](https://github.com/GeiserX/Pumperly/blob/main/prisma.config.ts).
- The `ALTER TABLE` widens the price column to match `prisma/schema.prisma`. [Run with Docker Compose](docker-compose.md#4-create-the-database-schema) explains why.

!!! warning "Use `migrate deploy`, not `db push`"
    `prisma/schema.prisma` does not declare the `geom` column that stores each station's position. The scrapers write it through raw SQL. `prisma db push` builds tables from the schema file alone, so it leaves `geom` out, and every scrape then fails.

### 5. Load some data

```bash
npm run scraper:run -- --country=ES
```

This runs Spain's fuel scraper once against your database and prints a summary. See [Run one scraper](#run-one-scraper) below.

### 6. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Before it starts, the `predev` step copies MapLibre's worker files into `public/maplibre/`. The map needs them to draw anything.

Routing and address search stay off until you set `VALHALLA_URL` and `PHOTON_URL`. You can point them at any Valhalla and Photon you can reach. See [Run without routing and address search](docker-compose.md#run-without-routing-and-address-search).

## Scripts

These are the scripts in [`package.json`](https://github.com/GeiserX/Pumperly/blob/main/package.json):

| Command | What it runs |
|---|---|
| `npm run dev` | `next dev`, after `predev` copies the MapLibre worker |
| `npm run build` | `next build`, after `prebuild` copies the MapLibre worker. The output is a standalone server in `.next/standalone`. |
| `npm run start` | `next start` |
| `npm run lint` | `eslint .` |
| `npm test` | The unit and component tests, offline |
| `npm run test:coverage` | The same tests with a coverage report |
| `npm run test:integration` | The integration tests, which need Docker |
| `npm run scraper:run -- <flags>` | The scraper command line, `npx tsx src/scrapers/cli.ts` |

The database module throws when `DATABASE_URL` is unset. CI and the Dockerfile set a placeholder value for the build, `postgresql://mock:mock@localhost:5432/mock`. With your `.env` in place, a local build finds a real one.

## Run one scraper

The command line in [`src/scrapers/cli.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/cli.ts) runs scrapers once, outside the dev server:

```bash
npm run scraper:run -- --country=FR
npm run scraper:run -- --country=ES,PT --once
npm run scraper:run -- --country=EV_DE_BNETZA
npm run scraper:run -- --country=all
```

| Flag | Meaning |
|---|---|
| `--country=<codes>` | Required. One code, a comma-separated list, or `all`. |
| `--once` | Run once and exit. This is already the default, so the flag changes nothing today. |

The codes are the scheduler's codes:

- A country code such as `ES` runs that country's fuel scraper. `AU` runs both Australian sources, Western Australia and New South Wales.
- `EV_XX` runs Open Charge Map for country `XX`, for example `EV_FR` or `EV_US`.
- `EV_ES_REVE` and `EV_DE_BNETZA` run the Spanish and German official charger registries.
- `all` runs every scraper. For Spain and Germany it picks one EV source, the same way the app does. Naming `EV_ES` or `EV_DE` yourself runs Open Charge Map for that country regardless.

An unknown code prints the list of valid ones and exits.

The command reads `.env`, so it writes to the database `DATABASE_URL` names. It ignores `PUMPERLY_ENABLED_COUNTRIES` and every interval setting. It runs the scrapers one after another, then prints a summary per scraper: status, time, stations written, prices written and any errors. It exits with status 1 if any scraper reported an error, so you can use it in a script.

!!! warning "It writes to a real database"
    A run replaces that source's prices for the country in the database `DATABASE_URL` points at. Check that line before you run it.

Community datasets that ship as static files run only from the app's scheduler, not from this command. See [Adding a country](../data/adding-a-country.md).

## Tests

The tests use [Vitest](https://vitest.dev). Test files sit next to the code they test.

### Unit and component tests

```bash
npm test
```

This runs two Vitest projects from [`vitest.config.ts`](https://github.com/GeiserX/Pumperly/blob/main/vitest.config.ts):

| Project | Files | Environment |
|---|---|---|
| `node` | `src/**/*.test.ts`, except `*.integration.test.ts` | Node.js |
| `components` | `src/**/*.test.tsx` | jsdom, a simulated browser, with Testing Library's matchers loaded from `vitest.setup.tsx` |

They run offline. Scraper tests replace `fetch` and the database client with test doubles, so no source is called and no database is needed.

To run one file, name it:

```bash
npx vitest run src/scrapers/spain.test.ts
```

`npm run test:coverage` adds a V8 coverage report, as text and as `coverage/lcov.info`. It covers `src/lib`, `src/scrapers`, `src/middleware.ts`, `src/app/api` and `src/components`.

### Integration tests

```bash
npm run test:integration
```

This uses [`vitest.integration.config.ts`](https://github.com/GeiserX/Pumperly/blob/main/vitest.integration.config.ts). It runs `src/**/*.integration.test.ts`. The suite there starts a real `postgis/postgis:17-3.4` container through [Testcontainers](https://testcontainers.com), imports the real `/api/route-stations` handler and runs its queries against PostGIS.

- Docker must be running.
- The suites run one at a time in a single worker. Startup can take a while: hooks may take up to 180 seconds, tests up to 60.
- Set `SKIP_INTEGRATION=1` to skip them, for example on a machine without Docker.

A file named `*.integration.test.tsx` is a component test despite the name. It runs with `npm test`, in the `components` project.

### What CI checks

The CI workflow runs on Node.js 22, for every pull request that changes code, the schema, dependencies or the Docker files:

1. `npx prisma generate`, then `npx tsc --noEmit` and `npm run lint`.
2. `npx vitest run --coverage`: the same tests as `npm test`.
3. `npm run build`.

Run the same commands before you open a pull request. [Contributing](../contributing.md) has the rest.

## Where things are

| Path | Holds |
|---|---|
| `src/app/[locale]/` | The map page, one path per language |
| `src/app/api/` | The HTTP API routes. See [HTTP API](../reference/api.md). |
| `src/components/` | The map, the search and route panel, the top bar |
| `src/lib/` | Shared code: configuration, Valhalla and Photon clients, currencies, translations |
| `src/scrapers/` | One file per source, plus `base.ts` with the shared write logic and `cli.ts` |
| `src/instrumentation.ts` | The scheduler |
| `src/middleware.ts` | The language redirect |
| `prisma/` | `schema.prisma` and the SQL migrations |
| `docker/` | The Dockerfile and the PostGIS compose file |
| `charts/pumperly/` | The Helm chart. See [Run on Kubernetes with Helm](kubernetes.md). |
| `scripts/` | The MapLibre worker copy step |
