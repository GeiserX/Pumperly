# Upgrading

This page explains how Pumperly releases are made and how to move an install to a newer one. It also lists what to check once the new version runs.

Most upgrades are a change of image tag and a restart. A release that adds a database migration needs one extra step, which you run yourself.

## How releases are cut

When a change that touches the app's code lands on `main`, a workflow tags a new version on its own. Nobody picks the number by hand.

```mermaid
flowchart LR
    A[Merge to main] --> B{Touches src/, prisma/,<br/>docker/ or package.json?}
    B -- no --> Z[No release]
    B -- yes --> C[Auto Tag picks the next version]
    C --> D[Tag vX.Y.Z pushed]
    D --> E[Docker Publish:<br/>amd64 + arm64 images]
    D --> F[GitHub Release<br/>with a changelog]
```

The version follows [semantic versioning](https://semver.org), read from the commit messages since the last tag:

| Commits since the last tag | Next version |
|----------------------------|--------------|
| A breaking change: `BREAKING CHANGE` in a message, or `!` before the colon, as in `feat!:` | Major: `1.14.0` becomes `2.0.0` |
| At least one `feat:` commit | Minor: `1.14.0` becomes `1.15.0` |
| Anything else, such as `fix:` or `chore:` | Patch: `1.14.0` becomes `1.14.1` |

The tag starts two workflows:

- **Docker Publish** builds the image on native `linux/amd64` and `linux/arm64` runners. It pushes both under one multi-architecture tag to [`drumsergio/pumperly`](https://hub.docker.com/r/drumsergio/pumperly).
- **GitHub Release** writes a changelog from the commit subjects since the previous tag, grouped into features, bug fixes and other changes. Read it on the [releases page](https://github.com/GeiserX/Pumperly/releases).

Changes that touch only the docs or the Helm chart do not cut an app release. The Helm chart has its own version and release path, described [below](#helm-chart-releases).

The workflows live in [`.github/workflows/auto-tag.yml`](https://github.com/GeiserX/Pumperly/blob/main/.github/workflows/auto-tag.yml), [`docker-publish.yml`](https://github.com/GeiserX/Pumperly/blob/main/.github/workflows/docker-publish.yml) and [`release.yml`](https://github.com/GeiserX/Pumperly/blob/main/.github/workflows/release.yml).

## Image tags { #image-tags }

| Tag | What it is |
|-----|------------|
| `1.15.1`, `v1.15.1` | A release. Both names point at the same image, for `linux/amd64` and `linux/arm64`. |
| `1.15.1-amd64`, `1.15.1-arm64` | The single-architecture images the multi-architecture tag is made of. You do not need them. |
| `latest` | Not tied to a release. Do not use it. |

Pin a release tag in your compose file or Helm values. With `latest` you cannot tell which version runs, and the app changes whenever the image is pulled again. That includes changes that need a migration you have not applied.

!!! note "Only the newest release gets fixes"
    There are no long-term support branches. Security fixes land in the next release from `main`. See [SECURITY.md](https://github.com/GeiserX/Pumperly/blob/main/SECURITY.md).

## The database schema is not migrated on start { #migrations }

The app starts the web server with `node server.js` and never changes the database schema. The image does carry the migration files of its release, under `prisma/migrations`, and [`migrate.mjs`](https://github.com/GeiserX/Pumperly/blob/main/docker/migrate.mjs), the script that applies them. Nothing runs that script unless you do: the shipped compose file runs it as the `migrate` service before the app starts, and any other setup runs it from the image, as shown [below](#apply-new-migrations). See [`docker/Dockerfile`](https://github.com/GeiserX/Pumperly/blob/main/docker/Dockerfile).

Schema changes ship as SQL files, one folder per migration, under [`prisma/migrations/`](https://github.com/GeiserX/Pumperly/tree/main/prisma/migrations). A release that adds a folder there needs you to apply it. A release that adds none needs nothing.

!!! warning "The migrations are the schema of record, not `schema.prisma`"
    The scrapers and the map queries read and write a PostGIS column, `stations.geom`. Only the migrations create it, together with its two spatial indexes. [`prisma/schema.prisma`](https://github.com/GeiserX/Pumperly/blob/main/prisma/schema.prisma) does not declare that column. A tool that makes the database match `schema.prisma`, such as `prisma db push`, therefore cannot build a working schema. On an existing database it would want to drop the column. Build and upgrade the schema from the migrations.

### Find out whether a release has migrations

Compare the two release tags. With a clone of the repository:

```bash
git fetch --tags
git diff --stat v1.13.7 v1.14.0 -- prisma/migrations
```

Without a clone, open the compare view on GitHub, for example `https://github.com/GeiserX/Pumperly/compare/v1.13.7...v1.14.0`, and look for files under `prisma/migrations/`.

No output means there is nothing to apply.

### Apply new migrations

Apply migrations before you start the new image. The new code may rely on them.

With the shipped `docker/docker-compose.yml` there is nothing to do here: its `migrate` service applies new migrations on every `up`, before the app starts, and records them in `_prisma_migrations`. See [Upgrade a Docker Compose install](#upgrade-a-docker-compose-install).

On any other setup, run the same script from the new release's image. It needs `DATABASE_URL` and a network path to the database:

```bash
docker run --rm --network <network of your database> \
  -e DATABASE_URL=postgresql://pumperly:<password>@<database host>:5432/pumperly \
  drumsergio/pumperly:<release> node migrate.mjs
```

It applies every migration the history does not list yet, oldest first, one transaction each, and records each one in `_prisma_migrations` with the checksum Prisma uses. On a database whose schema was built by hand, with no history, it first checks that `0_init` is complete (both tables and the `geom` column) and records it as applied, the same as `prisma migrate resolve --applied 0_init`. It refuses a partial schema with no history and a history row Prisma left unfinished, and when a migration fails it rolls that one back and exits with an error, so the history never lists a migration that did not run.

The rest of this section applies the migrations by hand instead. The commands follow the layout of [Run with Docker Compose](../getting-started/docker-compose.md), run from the repository root: the database service is `db` and the Pumperly service is `app`.

First check whether your database keeps a migration history. Prisma records applied migrations in a table called `_prisma_migrations`:

```bash
docker compose -f docker/docker-compose.yml exec db \
  psql -U pumperly -d pumperly -c 'SELECT migration_name FROM _prisma_migrations ORDER BY finished_at'
```

An error saying the relation does not exist means the database has no history. Pick the tab that matches:

=== "With a migration history"

    Run `prisma migrate deploy` from a checkout of the new release tag. It applies every migration the history does not list yet, in order:

    ```bash
    git clone https://github.com/GeiserX/Pumperly.git
    cd Pumperly
    git checkout v1.15.1
    npm ci
    DATABASE_URL=postgresql://pumperly:pumperly@localhost:5433/pumperly npx prisma migrate deploy
    ```

    `DATABASE_URL` must reach the database from where you run the command. The shipped [`docker/docker-compose.yml`](https://github.com/GeiserX/Pumperly/blob/main/docker/docker-compose.yml) publishes PostGIS on host port `5433`, with the password `pumperly`. Use your own password if you changed it.

=== "Without a migration history"

    Run the SQL of each new migration yourself, oldest folder first. The folder names sort in the order they must run. Run this from a checkout of the new release tag, so the files are on hand:

    ```bash
    docker compose -f docker/docker-compose.yml exec -T db \
      psql -v ON_ERROR_STOP=1 -U pumperly -d pumperly < prisma/migrations/<migration-folder>/migration.sql
    ```

    `ON_ERROR_STOP=1` makes `psql` stop at the first error instead of carrying on.

    To start keeping a history instead, first confirm that `stations` has a `geom` column (`\d stations` in `psql`). Then, from a checkout of the new release tag with `DATABASE_URL` set as in the other tab, mark the first migration as already applied and let `migrate deploy` take over:

    ```bash
    npx prisma migrate resolve --applied 0_init
    npx prisma migrate deploy
    ```

    Without this step `prisma migrate deploy` stops with error `P3005`, because the database is not empty.

!!! tip "Large tables and index builds"
    A migration that builds an index takes a lock that blocks writes to that table until it finishes. On a large `stations` table that can stall the scrapers. When a migration file offers a `CREATE INDEX CONCURRENTLY` variant in its comments, run that variant first with `psql`. If the migration's own statement uses `IF NOT EXISTS`, it then finds the index and does nothing.

Pumperly ships no down migrations. To go back to an older release after a migration ran, restore the backup you took before upgrading. See [Backing up the database](backup-and-restore.md).

## Upgrade a Docker Compose install

1. Read the [release notes](https://github.com/GeiserX/Pumperly/releases) for every release between yours and the new one.
2. Back up the database. See [Backing up the database](backup-and-restore.md).
3. Update the checkout. The compose file on `main` pins the newest release:

    ```bash
    git pull
    ```

    To move to a release other than the newest, check out its tag (for example `git checkout v1.15.0`) and set the image pin at the top of `docker/docker-compose.yml` to the same version. Both `migrate` and `app` use that one pin, so the migrations applied are always the ones of the image that runs.

4. Pull the new image and recreate the stack:

    ```bash
    docker compose -f docker/docker-compose.yml pull app
    docker compose -f docker/docker-compose.yml up -d
    ```

    `migrate` runs first and applies any new migration; the app restarts on the new image only if that succeeds. `docker compose -f docker/docker-compose.yml logs migrate` shows what it applied.

5. Run the [checks after an upgrade](#after-an-upgrade).

If you changed `docker/docker-compose.yml` yourself, `git pull` may stop on a conflict. Keep your changes in a second compose file passed with another `-f`, so the shipped file stays as released.

## Upgrade a Helm install { #helm }

The chart installs from the Helm repository published with this project:

```bash
helm repo add pumperly https://geiserx.github.io/Pumperly
helm repo update
helm search repo pumperly/pumperly --versions
```

Set `image.tag` in your values file to the release you want, then upgrade:

```yaml
image:
  tag: "1.15.1"
```

```bash
helm upgrade pumperly pumperly/pumperly -f my-values.yaml
```

!!! warning "Always set `image.tag`"
    The chart's default `image.tag` is not raised with every app release, so it can be many versions behind. Without your own `image.tag`, an upgrade of the chart can leave you on an old app.

What the chart does during an upgrade:

- **Downtime.** The web Deployment uses the `Recreate` strategy by default. Kubernetes stops the old pod before it starts the new one, so the site is down for the length of a start. This is on purpose: every pod runs the scrapers, and two overlapping pods would scrape the same sources twice. Keep `replicaCount: 1`.
- **Secrets.** When the chart manages the Secret, a change to it rolls the web pod.
- **Database init step.** With `databaseInit.enabled: true`, the default, an init container runs `npx prisma db push` before the app starts. The chart refuses to render if you combine it with `replicaCount` above 1.

!!! warning "Apply migrations yourself on Kubernetes too"
    `prisma db push` syncs the database to `schema.prisma`, which does not declare the `geom` column. See [the schema warning](#migrations). Set `databaseInit.enabled: false` and apply new migrations from a checkout of the release tag, as [above](#migrations). Reach the database with `kubectl port-forward` to the PostGIS service, or run `psql` inside the PostGIS pod.

For the chart's other values, see [Run on Kubernetes with Helm](../getting-started/kubernetes.md) and the [chart README](https://github.com/GeiserX/Pumperly/blob/main/charts/pumperly/README.md).

### Helm chart releases { #helm-chart-releases }

The chart is versioned on its own, in [`charts/pumperly/Chart.yaml`](https://github.com/GeiserX/Pumperly/blob/main/charts/pumperly/Chart.yaml). A merge to `main` that changes the chart publishes it with chart-releaser, under the version in that file. A chart version that already exists is not published again. So a new app release does not mean a new chart release, and the other way round.

## Checks after an upgrade { #after-an-upgrade }

A running container and passing health probes do not prove the site works. The Helm probes call `/api/config`, which answers from configuration alone and never touches the database. Work through these checks after every upgrade.

### 1. The scrapers started

Read the app's logs. At start, the scheduler prints one line per enabled source:

```text
[scraper] ES: scraping every 12h
```

The first runs start 10 seconds after boot and are spaced 5 seconds apart. Each one ends with a summary line:

```text
[scraper] ES: OK — <n> stations, <n> prices in <s>s
```

A line with `error(s)` instead of `OK` points to a problem with that source. See [Monitoring and troubleshooting](troubleshooting.md).

### 2. The map shows stations { #map-check }

Open the site in a browser and look at the map itself. Move to a country you enabled. Station markers, or clusters of them when zoomed out, must appear on top of the base map.

!!! danger "A map with only its background is broken, even when everything else passes"
    The map draws in a MapLibre web worker, a script the browser loads from `/maplibre/` on your site. If that script fails to load, the map paints only the plain background colour of its style, with no roads, labels or stations. Everything else keeps working. The station API returns data, routes calculate, and the probes stay green. Only looking at the map catches this failure.

If you see only the background:

- Open the browser's developer tools and look for a failed request for `maplibre-gl-worker.mjs` or `maplibre-gl-shared.mjs`.
- Check that both worker files answer with HTTP 200 and a JavaScript content type:

    ```bash
    curl -sI https://pumperly.example.com/maplibre/maplibre-gl-worker.mjs
    curl -sI https://pumperly.example.com/maplibre/maplibre-gl-shared.mjs
    ```

    A 404, or an HTML content type, means the worker cannot start. Check whether a reverse proxy or cache in front of Pumperly rewrites or blocks `/maplibre/`.

- If the files load and the map is still empty, report it with the console output. See [Reporting a bug](troubleshooting.md#reporting-a-bug).

### 3. The data is fresh

`/api/stats` queries the database and returns, per country, the station count, the price count and the time of the newest price:

```bash
curl -s https://pumperly.example.com/api/stats
```

After the first scrape cycle, `lastUpdate` for each country with fuel prices should be later than the time of the upgrade. A country with only charging stations has no prices, so its `lastUpdate` is `null`. An answer of HTTP 500 means the app cannot query the database. The response lets shared caches keep it for 5 minutes and serve it stale for 10 more while they refresh it, so a caching proxy may show an answer up to 15 minutes old.

To test the endpoint the map uses, ask for the stations in a small box. The box is `minLon,minLat,maxLon,maxLat`, and `fuel` is a fuel code such as `B7`:

```bash
curl -s 'https://pumperly.example.com/api/stations?bbox=-3.75,40.38,-3.65,40.45&fuel=B7'
```

The answer is a GeoJSON `FeatureCollection`. Its `features` list must not be empty for an area with stations. See [HTTP API](../reference/api.md) for the parameters.

### 4. Routing and search work

If you run Valhalla and Photon, plan a route between two addresses on the map. Typing in the search box tests Photon, and the route tests Valhalla. See [Valhalla or Photon is not ready](troubleshooting.md#valhalla-or-photon-is-not-ready) if either fails.
