# Backing up the database

This page covers what to back up in a Pumperly install, how to dump and restore the PostGIS database, and what you can rebuild instead of backing up.

## What holds state

Pumperly keeps its data in one PostgreSQL database with the PostGIS extension. PostGIS adds the spatial types and indexes the map queries rely on. The database holds two tables of its own:

| Table | What it holds |
|-------|---------------|
| `stations` | One row per fuel station or charging location, with its position in the `geom` column |
| `fuel_prices` | The current prices per station and fuel, with the source and the time of the scrape |

A database built with `prisma migrate deploy` also has `_prisma_migrations`, the list of applied migrations. See [Data model](../reference/data-model.md) for the columns.

The rest of the stack lives elsewhere:

| Item | Where it lives | Back it up? |
|------|----------------|-------------|
| PostGIS database | The `pumperly-pgdata` volume in the shipped compose file. The `postgis` StatefulSet's volume on Helm. | Yes, with `pg_dump`. See below. |
| Your configuration | `.env` and your compose file, or your Helm values file and the chart's Secret | Yes. It holds `DATABASE_URL` and your API keys. |
| Valhalla routing tiles | Valhalla's own volume | Optional. Rebuilt from OpenStreetMap extracts. |
| Photon geocoding index | Photon's own volume | Optional. Rebuilt from the Photon dumps. |

!!! warning "Treat the configuration backup like a password"
    `.env` and the Helm values hold your database password and API keys. Keep that copy on storage only you can read.

    On Helm with the bundled PostGIS, leaving `postgis.auth.password` empty makes the chart generate a random password. It lives only in the chart's Secret, `pumperly-secret` for a release called `pumperly`, so back up that Secret too. If the Secret is lost while the PostGIS volume survives, a reinstall generates a new password that the existing database does not accept.

## What you can rebuild instead

Most of the database refills on its own. The scrapers run inside the app. The first one starts 10 seconds after boot, and the others follow 5 seconds apart. On an empty database with the schema in place, the map fills as each source finishes its first run. See [Countries and scrape schedule](../configuration/countries-and-schedule.md).

Each scrape replaces a source's prices in full. Pumperly keeps no price history, so an old dump holds nothing that a fresh scrape would not replace.

A backup still saves you from three losses:

- **Sources that are down or blocked.** When a source fails, Pumperly keeps its last good prices. An empty database has nothing to keep, so those countries stay blank until the source works again.
- **Slow first loads.** Some sources take a long time to load in full. The Spanish charging registry, Mapa REVE, allows 5 requests per hour, so its first full load takes about 37 hours at the default settings.
- **Downtime.** A restore takes minutes. A full re-scrape of every country takes a lot longer, and some sources only refresh a few times a day.

Valhalla and Photon hold no Pumperly data. In the setups those pages describe, each builds its data on first start when its volume is empty. Valhalla downloads OpenStreetMap extracts and builds routing tiles, which takes hours and a lot of memory. Photon downloads and imports its country dumps, which can take longer still. Back up their volumes only if you want to skip that wait. See [Routing with Valhalla](../configuration/routing-valhalla.md) and [Geocoding with Photon](../configuration/geocoding-photon.md).

## Take a backup

`pg_dump` in its custom format (`-Fc`) writes one compressed file that `pg_restore` can read back. It takes a consistent snapshot while the app keeps running, so there is no need to stop anything.

=== "Docker Compose"

    The shipped [`docker/docker-compose.yml`](https://github.com/GeiserX/Pumperly/blob/main/docker/docker-compose.yml) names the database service `db`, with user and database `pumperly`. Run this from the repository root:

    ```bash
    docker compose -f docker/docker-compose.yml exec -T db \
      pg_dump -U pumperly -d pumperly -Fc > pumperly-$(date +%F).dump
    ```

    `-T` turns off the terminal that `docker compose exec` opens by default. Without it the binary dump can be corrupted on its way to the file.

=== "Helm"

    With the bundled PostGIS, the chart runs a StatefulSet. For a release called `pumperly`, it is `pumperly-postgis`, and its pod is `pumperly-postgis-0`. A release whose name contains `pumperly` keeps its name, so `my-pumperly` gives `my-pumperly-postgis`. Any other release name gives `<release>-pumperly-postgis`. See [Run on Kubernetes with Helm](../getting-started/kubernetes.md) for the object names.

    ```bash
    kubectl exec pumperly-postgis-0 -- pg_dump -U pumperly -d pumperly -Fc > pumperly-$(date +%F).dump
    ```

    The user and database come from `postgis.auth.username` and `postgis.auth.database`, both `pumperly` by default. Add `-n <namespace>` if the release is not in your current namespace.

=== "External database"

    Point `pg_dump` at the same database as `DATABASE_URL`. The client's major version must be the same as the server's or newer:

    ```bash
    pg_dump -d 'postgresql://pumperly:change-me@db.example.com:5432/pumperly' -Fc > pumperly-$(date +%F).dump
    ```

Check that the dump is readable before you rely on it. This lists its contents and fails on a broken file:

```bash
pg_restore --list pumperly-2026-01-01.dump | head
```

The list should include the `stations` and `fuel_prices` tables.

## Restore

A restore replaces the whole database. Stop the app first, so the scrapers do not write while you restore.

The steps below restore into a new, empty database. The dump brings the PostGIS extension, the tables, the indexes and the data. Restore into the same PostgreSQL major version or a newer one. The shipped compose file and the chart both use PostGIS on PostgreSQL 17.

=== "Docker Compose"

    ```bash
    # 1. Stop the app. The database keeps running.
    docker compose -f docker/docker-compose.yml stop app

    # 2. Replace the database with an empty one.
    docker compose -f docker/docker-compose.yml exec db dropdb -U pumperly pumperly
    docker compose -f docker/docker-compose.yml exec db createdb -U pumperly pumperly

    # 3. Load the dump.
    docker compose -f docker/docker-compose.yml exec -T db \
      pg_restore -U pumperly -d pumperly --no-owner < pumperly-2026-01-01.dump

    # 4. Start the app again.
    docker compose -f docker/docker-compose.yml start app
    ```

    These commands follow the layout of [Run with Docker Compose](../getting-started/docker-compose.md), where the Pumperly service is `app` in `docker/docker-compose.yml`. Adjust the file name and the service name if your setup differs. `start app` does not rerun `migrate`: the dump already carries the schema of the release it was taken from.

=== "Helm"

    ```bash
    # 1. Stop the app.
    kubectl scale deployment pumperly --replicas=0

    # 2. Replace the database with an empty one.
    kubectl exec pumperly-postgis-0 -- dropdb -U pumperly pumperly
    kubectl exec pumperly-postgis-0 -- createdb -U pumperly pumperly

    # 3. Load the dump.
    kubectl exec -i pumperly-postgis-0 -- pg_restore -U pumperly -d pumperly --no-owner < pumperly-2026-01-01.dump

    # 4. Start the app again.
    kubectl scale deployment pumperly --replicas=1
    ```

    The Deployment is named after the release when the release name contains `pumperly`, as in `pumperly` or `my-pumperly`. Any other release name gives `<release>-pumperly`.

`dropdb` fails while a client is still connected. If it reports that other sessions are using the database, make sure the app is stopped, then try again.

`pg_restore` prints errors and carries on. Read its output. A restore that printed errors may be incomplete.

### Check the restore

Before you start the app, confirm the data and the spatial column are there:

```bash
docker compose -f docker/docker-compose.yml exec db \
  psql -U pumperly -d pumperly -c 'SELECT country, count(*) FROM stations GROUP BY country ORDER BY 2 DESC'
docker compose -f docker/docker-compose.yml exec db \
  psql -U pumperly -d pumperly -c '\d stations'
```

The first command should list your countries. The second should show a `geom` column of type `geometry(Point,4326)`.

On Helm, run the same `psql` commands with `kubectl exec pumperly-postgis-0 --` in place of `docker compose -f docker/docker-compose.yml exec db`.

Then start the app and run the [checks after an upgrade](upgrading.md#after-an-upgrade). They apply to a restore too. The first scraper starts 10 seconds after boot. Source by source, the scrapers replace the restored prices with fresh ones.

### Restoring an older dump into a newer release

A dump carries the schema of the release that wrote it. If you restore it under a newer release, apply the migrations added since then. See [the database schema](upgrading.md#migrations).
