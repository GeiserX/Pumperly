# Development

This page explains how to send a change to Pumperly: the project rules, local setup, and what a pull request needs before it can merge. Changes arrive as pull requests against `main`, usually from a fork. For anything beyond a small fix, open an issue first to discuss the change.

Pumperly is licensed under the [GNU Affero General Public License v3.0 or later](https://github.com/GeiserX/Pumperly/blob/main/LICENSE) (AGPL-3.0-or-later). Your contribution is distributed under the same licence as the rest of the project.

## Rules that come first

!!! danger "The privacy rule"
    Issues, pull requests, commits, review comments, docs and tests are all public.

    - Never describe a real deployment: no hostnames, IP addresses, ports, domains, server names or paths of a running install.
    - Never paste station counts, price counts or other figures from a running instance. Describe the problem in the project's own terms.
    - Never name a person, and never quote a private conversation.
    - Fake data in tests and docs must look fake, such as `pumperly.example.com` or `Station A`.

    Remove these details from logs before you paste them. If one was pushed by mistake, remove it everywhere it reached at once: edit the pull request body or comment, rewrite the commit on your unmerged branch, or fix the file in a follow-up commit. If it already reached `main`, tell the maintainer.

!!! warning "The data-source rule"
    A scraper may use a source only when all of these are true:

    - The data is public. It needs no login, or only a free key the source hands out for this use.
    - The source's `robots.txt` allows the paths the scraper fetches.
    - The source's licence or terms allow reuse. Put the licence and the required attribution in the scraper and in the pull request.

    A scraper never evades a block. It does not spoof a browser or another app's user agent, reuse another client's secret tokens, rotate addresses or bypass a captcha. When a source starts refusing Pumperly, the project stops using it, and the country waits for a source that allows it. [Coverage and status](data/coverage.md) lists the countries in that state.

## Set up a checkout

You need Node.js 22, the version CI and the Docker image use, and Docker for the database.

```bash
git clone https://github.com/YOUR_USERNAME/Pumperly.git
cd Pumperly
npm ci
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d db
```

`up -d db` starts PostGIS only, published on port `5433` of your machine; the app runs from your checkout instead of the image. The shipped compose file:

```yaml
--8<-- "docker/docker-compose.yml"
```

`.env.example` points `DATABASE_URL` at the `pumperly-db` container name, which your machine cannot resolve. In `.env`, change it to the published port:

```bash
DATABASE_URL=postgresql://pumperly:pumperly@localhost:5433/pumperly
```

Then create the database schema and start the app:

```bash
npx prisma generate        # writes the client to src/generated/prisma
npx prisma migrate deploy  # applies prisma/migrations
npm run dev
```

The `ALTER TABLE` widens the price column to match `prisma/schema.prisma`. [Run from source](#4-generate-the-prisma-client-and-create-the-schema) explains each step.

The map opens at `http://localhost:3000`.

!!! tip "Scrape less while you develop"
    On start, the app schedules a scraper for every country it knows. Set `PUMPERLY_ENABLED_COUNTRIES=ES` in `.env` to scrape only the country you work on, or `PUMPERLY_SCRAPE_INTERVAL_HOURS=0` to turn scheduled scraping off. Enabling a country also enables its EV chargers unless `PUMPERLY_EV_ENABLED=0`. See [Countries and scrape schedule](configuration/countries-and-schedule.md).

Route planning needs Valhalla and address search needs Photon. You can work on the map, the scrapers and the station API without either. [Run from source](#run-from-source) covers the full setup.

### Run one scraper

The scraper CLI runs one or more scrapers once against the database in `DATABASE_URL`, then prints what it wrote:

```bash
npm run scraper:run -- --country=ES
npm run scraper:run -- --country=ES,PT
npm run scraper:run -- --country=all
```

Country codes are ISO 3166-1 alpha-2, such as `ES`. EV sources have their own keys, such as `EV_ES` for Open Charge Map in Spain. An unknown code prints the full list and exits.

## Tests

Tests are [Vitest](https://vitest.dev/) files next to the code they test: `spain.ts` has `spain.test.ts` beside it.

```bash
npm test                  # unit and component tests
npm run test:coverage     # the same, with a coverage report
npm run test:integration  # integration tests, needs Docker
```

`npm test` runs two Vitest projects:

| Project | Files | Environment |
| --- | --- | --- |
| `node` | `src/**/*.test.ts`, except integration tests | Node |
| `components` | `src/**/*.test.tsx` | jsdom, with `vitest.setup.tsx` |

Integration tests end in `.integration.test.ts`. They start a throwaway PostGIS container with [Testcontainers](https://testcontainers.com/), so they need a running Docker daemon. They run one file at a time.

Add a test with every change. A bug fix gets a test that fails without the fix. A new scraper gets a test that feeds it a sample of the source's response through a mocked `fetch`, so the test never calls the real source.

Coverage is measured on `src/lib`, `src/scrapers`, `src/app/api`, `src/components` and `src/middleware.ts`. The [Codecov](https://codecov.io/gh/GeiserX/Pumperly) target is 90% for the project and for each patch.

## Lint, types and build

```bash
npm run lint      # ESLint with the Next.js config
npx tsc --noEmit  # type check; needs the generated Prisma client
npm run build     # production build
```

TypeScript runs in strict mode. Validate API input with [Zod](https://zod.dev/), as the existing routes do. User-facing text goes through the translation helpers in `src/lib/i18n.tsx`, never as a hard-coded string.

## Translations

The interface ships in 17 languages. Every string lives in one file, [`src/lib/i18n.tsx`](https://github.com/GeiserX/Pumperly/blob/main/src/lib/i18n.tsx), with no separate JSON files. Components read a string with `t("key")` from the `useI18n()` hook.

### Add or change a string

The `translations` object in `i18n.tsx` holds one map per language, from `es` to `ca`. Each map pairs a key, such as `"search.origin"`, with the text in that language.

1. Add the key and its Spanish text to the `es` map. Spanish is the fallback for every other language.
2. Add the same key to each of the other 16 maps, with the text in that language.
3. Use it in the component as `t("search.origin")`.

!!! warning "A missing key does not fail anything"
    `t()` looks the key up in the current language, then in Spanish, then returns the key itself. A key you forget in one language shows Spanish text to those users. A key missing from Spanish too shows the raw key, such as `search.origin`, on screen. TypeScript, the tests and the build all pass either way. Check each map by eye before you open the pull request.

### Add a language

A language touches more than the `translations` object. Every step below names a place in the code:

| Step | File | What to add |
|---|---|---|
| 1 | [`src/lib/i18n.tsx`](https://github.com/GeiserX/Pumperly/blob/main/src/lib/i18n.tsx) | The code in the `Locale` type. |
| 2 | same | An entry in `LOCALES`: the code, the language's own name and a two-letter flag code. This list fills the language picker. |
| 3 | same | A full map in `translations`, with every key the `es` map has. |
| 4 | [`src/lib/og-translations.ts`](https://github.com/GeiserX/Pumperly/blob/main/src/lib/og-translations.ts) | An entry in `OG_TRANSLATIONS`: the page title, the description, the subtitle of the link preview image and the Open Graph locale, such as `ca_ES`. |
| 5 | [`src/app/layout.tsx`](https://github.com/GeiserX/Pumperly/blob/main/src/app/layout.tsx) | The code in the `inLanguage` list of the JSON-LD block. |

The code must be two lowercase letters. The tests check this, and the language switch in `i18n.tsx` only recognises a two-letter path prefix.

Step 4 is the one that turns the language on for visitors. `SUPPORTED_LOCALES` is built from the keys of `OG_TRANSLATIONS`. The middleware uses it to pick a visitor's language from the `Accept-Language` header and to accept `/<code>` paths. The sitemap and the `hreflang` alternates list one URL per entry in it. Once step 1 is in, TypeScript refuses to build until steps 3 and 4 have an entry for the new code, because both objects are typed by `Locale`. It does not check that the step 3 map has every key. It does not enforce step 5 either: that list is kept by hand, and today it lacks `ca`.

## Database changes

The schema lives in [`prisma/schema.prisma`](https://github.com/GeiserX/Pumperly/blob/main/prisma/schema.prisma). A schema change also needs a migration in `prisma/migrations`:

```bash
npx prisma migrate dev --create-only --name describe-the-change
npx prisma migrate deploy
```

`--create-only` writes the migration without applying it, so you can read the SQL first. Then `migrate deploy` applies it. Commit the schema change and the new migration folder together.

!!! warning "Keep the PostGIS column"
    The `geom` column on `stations` and its spatial index exist only in the migration SQL, not in `schema.prisma`. A generated migration can try to drop them. Delete any such statement from the SQL before you apply it. [Data model](reference/data-model.md) describes the tables.

## Add a country

A new country is a new scraper class plus its registration, its default scrape interval and its test. [Adding a country](data/adding-a-country.md) walks through every step.

A place with no API to scrape can still get stations. You commit a plain data file under [`src/scrapers/data/`](https://github.com/GeiserX/Pumperly/blob/main/src/scrapers/data/README.md), and it is loaded like any other source. That folder's README walks through it, starting from an example file.

Both paths follow the [data-source rule](#rules-that-come-first).

## Build the docs locally

The site is built with MkDocs Material and published at <https://geiserx.github.io/Pumperly>.

```bash
pip install -r docs/requirements-docs.txt
mkdocs serve           # live preview at http://127.0.0.1:8000
mkdocs build --strict  # what CI runs
```

The strict build fails on any warning, including a broken link, a missing anchor, an absolute link between pages or a missing snippet include.

- Every new page needs an entry in the `nav` section of `mkdocs.yml`.
- MkDocs builds every Markdown file under `docs/`. A file that must not become a page goes in `exclude_docs`.
- Link between pages with relative paths, such as `[Data model](reference/data-model.md)` from this page. Link to repository files with full `https://github.com/GeiserX/Pumperly/blob/main/...` addresses.
- Include a shipped file instead of copying it. A line `--8<-- "docker/docker-compose.yml"` inside a code block pulls the file in at build time, so the page cannot drift from it. A missing file fails the build.

A pull request that touches `docs/`, `mkdocs.yml`, `docker/docker-compose.yml` or `.env.example` runs the strict build. A merge to `main` that touches them publishes the site.

!!! warning "Some included files do not trigger the docs workflow"
    The workflow watches only the paths above. Several pages include other files:

    - `charts/pumperly/values.yaml`, on [Run on Kubernetes with Helm](getting-started/kubernetes.md#the-full-values-file)
    - `prisma/schema.prisma` and both `prisma/migrations/*/migration.sql` files, on [Data model](reference/data-model.md)
    - `.github/workflows/reve-key-renewal.yml`, on [EV charging sources](data/ev-sources.md#reve-key-renewal)

    A change to one of these files does not rebuild the site. The published page keeps the old copy until the next docs change reaches `main`. A pull request that renames or deletes one of them also skips the strict build, so the broken include only fails the next docs change.

    When your change touches one of these files, run `mkdocs build --strict` locally. After the merge, run the Documentation workflow by hand from the Actions tab to publish the new copy.

!!! note "The site shares its branch with the Helm repository"
    The `gh-pages` branch also serves the Helm chart index. The docs workflow syncs the built site into that branch and keeps `index.yaml` and the chart packages. Never run `mkdocs gh-deploy`: it replaces the whole branch and breaks `helm repo add`.

## Branches, commits and pull requests

Branch from `main` and name the branch by its kind of change, such as `feat/`, `fix/` or `docs/`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), in the form `type(scope): description`. For example:

```text
fix(scrapers): skip stations with coordinates outside the country
```

Pull requests are squash-merged, so the pull request title becomes the commit on `main`. Write the title as a Conventional Commit that says why the change matters.

The type in that title sets the next version. When a merge to `main` touches `src/`, `prisma/`, `docker/` or `package.json`, a workflow bumps the version and tags it:

| Commits since the last tag | Version bump |
| --- | --- |
| Any `!` after the type, such as `feat!:`, or `BREAKING CHANGE` in a body | Major |
| At least one `feat` | Minor |
| Anything else | Patch |

The tag builds and publishes the Docker image and creates the GitHub release.

### What a pull request needs

A pull request runs these checks, depending on the files it changes. Fix any that fail before you ask for a merge:

| Check | Runs when | What it runs |
| --- | --- | --- |
| CI: Lint & Type Check | Code, schema, Docker or dependency changes | `npx tsc --noEmit` and `npm run lint` |
| CI: Test | Same | The unit and component tests, with coverage. Integration tests do not run in CI |
| CI: Build | Same | `npm run build` |
| CI: CI Summary | Same | Fails when any of the three above failed |
| CodeQL: Analyze | Changes under `src/`, `prisma/` or the package files | Static analysis of the JavaScript and TypeScript |
| Documentation: build (strict) | Docs changes | `mkdocs build --strict` |

[CodeRabbit](https://www.coderabbit.ai/) reviews every pull request automatically. Read each of its comments, and fix the ones that are right or reply saying why not. It skips draft pull requests and titles containing `WIP`, so open the pull request as ready for review.

In the description, say what problem the change solves, then how. For a new source, name its licence and confirm the data-source rule holds.

## Issues and security

Open an [issue](https://github.com/GeiserX/Pumperly/issues) for a bug, a wrong price or a feature idea. Search the open issues first. For a bug, include the version, how you deploy, what happened, what you expected and the steps to reproduce. Follow the privacy rule in every log you paste. Before you request a feature, check the [roadmap](roadmap.md).

Never report a security problem in a public issue. Use [GitHub Security Advisories](https://github.com/GeiserX/Pumperly/security/advisories/new), or the email address in the [security policy](https://github.com/GeiserX/Pumperly/blob/main/SECURITY.md). Only the latest version receives fixes.

## Run from source

This section sets up a checkout for working on Pumperly in full: the database, the dev server, the scraper command line and the tests. To run Pumperly rather than change it, use [Run with Docker Compose](getting-started/docker-compose.md).

### What you need

- Node.js 22. CI and the Docker image both use it.
- npm. The repository ignores other package managers' lockfiles, so `package-lock.json` is the only one.
- Docker, for PostGIS and for the integration tests.

### Set up a checkout

#### 1. Clone and install

```bash
git clone https://github.com/GeiserX/Pumperly.git
cd Pumperly
npm ci
cp .env.example .env
```

`npm ci` installs exactly what `package-lock.json` lists, as CI does.

#### 2. Point `.env` at the local database

The `DATABASE_URL` in `.env.example` names the host `pumperly-db`, which only resolves inside Docker. From your machine, the shipped compose file publishes PostGIS on port 5433. Change the line to:

```ini
DATABASE_URL=postgresql://pumperly:pumperly@localhost:5433/pumperly
```

Two more lines keep a dev session small:

```ini
PUMPERLY_ENABLED_COUNTRIES=ES
PUMPERLY_SCRAPE_INTERVAL_HOURS=0
```

The dev server runs the same scheduler as production. The first line limits it to one country. The second turns it off, so nothing scrapes until you run the command line yourself. See [What happens on first start](getting-started/first-start.md#the-scheduler).

#### 3. Start PostGIS

```bash
docker compose -f docker/docker-compose.yml up -d db
```

This starts only the database. See [What the shipped compose file runs](getting-started/docker-compose.md#what-the-shipped-compose-file-runs).

#### 4. Generate the Prisma client and create the schema

```bash
npx prisma generate
npx prisma migrate deploy
```

- `prisma generate` writes the typed database client to `src/generated/prisma`. Git ignores that directory, so every fresh checkout needs this step. The tests and the build need it too.
- `prisma migrate deploy` applies the SQL files under `prisma/migrations` and records them. It reads `DATABASE_URL` from `.env` through [`prisma.config.ts`](https://github.com/GeiserX/Pumperly/blob/main/prisma.config.ts).
- The `ALTER TABLE` widens the price column to match `prisma/schema.prisma`. [Run with Docker Compose](getting-started/docker-compose.md#4-create-the-database-schema) explains why.

!!! warning "Use `migrate deploy`, not `db push`"
    `prisma/schema.prisma` does not declare the `geom` column that stores each station's position. The scrapers write it through raw SQL. `prisma db push` builds tables from the schema file alone, so it leaves `geom` out, and every scrape then fails.

#### 5. Load some data

```bash
npm run scraper:run -- --country=ES
```

This runs Spain's fuel scraper once against your database and prints a summary. See [Run one scraper](#run-one-scraper) below.

#### 6. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Before it starts, the `predev` step copies MapLibre's worker files into `public/maplibre/`. The map needs them to draw anything.

Routing and address search stay off until you set `VALHALLA_URL` and `PHOTON_URL`. You can point them at any Valhalla and Photon you can reach. See [Run without routing and address search](getting-started/docker-compose.md#run-without-routing-and-address-search).

### Scripts

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

### Run one scraper

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

Community datasets that ship as static files run only from the app's scheduler, not from this command. See [Adding a country](data/adding-a-country.md).

### Tests

The tests use [Vitest](https://vitest.dev). Test files sit next to the code they test.

#### Unit and component tests

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

#### Integration tests

```bash
npm run test:integration
```

This uses [`vitest.integration.config.ts`](https://github.com/GeiserX/Pumperly/blob/main/vitest.integration.config.ts). It runs `src/**/*.integration.test.ts`. The suite there starts a real `postgis/postgis:17-3.4` container through [Testcontainers](https://testcontainers.com), imports the real `/api/route-stations` handler and runs its queries against PostGIS.

- Docker must be running.
- The suites run one at a time in a single worker. Startup can take a while: hooks may take up to 180 seconds, tests up to 60.
- Set `SKIP_INTEGRATION=1` to skip them, for example on a machine without Docker.

A file named `*.integration.test.tsx` is a component test despite the name. It runs with `npm test`, in the `components` project.

#### What CI checks

The CI workflow runs on Node.js 22, for every pull request that changes code, the schema, dependencies or the Docker files:

1. `npx prisma generate`, then `npx tsc --noEmit` and `npm run lint`.
2. `npx vitest run --coverage`: the same tests as `npm test`.
3. `npm run build`.

Run the same commands before you open a pull request. The sections above have the rest.

### Where things are

| Path | Holds |
|---|---|
| `src/app/[locale]/` | The map page, one path per language |
| `src/app/api/` | The HTTP API routes. See [HTTP API](reference/api.md). |
| `src/components/` | The map, the search and route panel, the top bar |
| `src/lib/` | Shared code: configuration, Valhalla and Photon clients, currencies, translations |
| `src/scrapers/` | One file per source, plus `base.ts` with the shared write logic and `cli.ts` |
| `src/instrumentation-node.ts` | The scheduler, loaded by `src/instrumentation.ts` in the Node.js runtime |
| `src/middleware.ts` | The language redirect |
| `prisma/` | `schema.prisma` and the SQL migrations |
| `docker/` | The Dockerfile and the PostGIS compose file |
| `charts/pumperly/` | The Helm chart. See [Run on Kubernetes with Helm](getting-started/kubernetes.md). |
| `scripts/` | The MapLibre worker copy step |

### The short version

The whole setup above, as one block:

```bash
git clone https://github.com/GeiserX/Pumperly.git
cd Pumperly
npm install
cp .env.example .env
# Start PostGIS:
docker compose -f docker/docker-compose.yml up -d db
# Generate Prisma client + apply the migrations:
npx prisma generate && npx prisma migrate deploy
# Seed data for one country:
npm run scraper:run -- --country=ES
# Start dev server:
npm run dev
```

Open `http://localhost:3000`.

#### Available scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run scraper:run -- --country=XX` | Run scraper for a country (or `--country=all`) |

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
