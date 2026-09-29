# Run on Kubernetes with Helm

This page installs Pumperly on a Kubernetes cluster with the Helm chart in [`charts/pumperly`](https://github.com/GeiserX/Pumperly/tree/main/charts/pumperly). It lists what the chart deploys, the values that matter, and the steps the chart does not do for you.

## What the chart deploys

| Component | Kind | On by default | Notes |
|---|---|---|---|
| The app | Deployment, Service, ServiceAccount | yes | One replica, `Recreate` updates. Service on port 3000. |
| Ingress | Ingress | no | Turn on with `ingress.enabled`. |
| PostGIS | StatefulSet, Service | yes | `postgis/postgis:17-3.4-alpine`, 5 GiB volume. |
| Credentials | Secret | yes | Holds `DATABASE_URL`, the PostGIS login and any API keys. Skipped when you set `existingSecret`. |
| Valhalla | Deployment, Service, PersistentVolumeClaim | no | Routing. 100 GiB volume. |
| Photon | Deployment, Service, PersistentVolumeClaim | no | Address search. 300 GiB volume. You supply the image. |
| PodDisruptionBudget | PodDisruptionBudget | no | For the app. With the default `minAvailable: 1` it blocks node drains. See [Node drains and the disruption budget](#node-drains-and-the-disruption-budget). |
| Connection test | Pod, Helm test hook | on `helm test` | Requests `/api/config` from the app's Service. |

The app pod also has up to two init containers, which run before the app starts:

- `wait-for-database` waits until the database port answers, for up to `waitForDatabase.timeoutSeconds` (300 by default).
- `prisma-db-push` runs `npx prisma db push` in the app image. Read [The schema](#the-schema) before you rely on it.

The chart requires Kubernetes 1.21 or newer.

## Install

### 1. Add the chart repository

```bash
helm repo add pumperly https://geiserx.github.io/Pumperly
helm repo update
```

### 2. Write a values file

Start from this `my-values.yaml` and change what you need:

```yaml
image:
  tag: "1.14.0"          # the newest release; the chart's default is older

config:
  defaultCountry: "ES"
  enabledCountries: "ES,PT"

apiKeys:
  openChargeMap: "your-ocm-key"

databaseInit:
  enabled: false         # see "The schema" below

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: pumperly.example.com
      paths:
        - path: /
          pathType: Prefix
```

- Set `image.tag`. The chart pins an older app version as its default. Use the newest version from the [releases page](https://github.com/GeiserX/Pumperly/releases), without the `v`.
- Every value under `config` is a string. The chart's schema rejects numbers and booleans there. With `--set`, use `--set-string`, for example `--set-string config.evEnabled=0`.
- The database password is generated on first install, 24 random characters, and kept across upgrades. Set `postgis.auth.password` only if you want to choose it.

### 3. Install

```bash
helm install pumperly pumperly/pumperly -f my-values.yaml
```

With the release name `pumperly`, the objects are called `pumperly` (the app), `pumperly-postgis`, `pumperly-valhalla`, `pumperly-photon` and `pumperly-secret`. A release name that contains `pumperly`, such as `my-pumperly`, is used as it is: `my-pumperly`, `my-pumperly-postgis` and so on. Any other release name gets `-pumperly` appended: `maps` gives `maps-pumperly`, `maps-pumperly-postgis` and so on.

### 4. Create the schema

Do this once, after PostGIS is running. See [The schema](#the-schema) for why.

```bash
kubectl rollout status statefulset/pumperly-postgis
for f in prisma/migrations/*/migration.sql; do
  kubectl exec -i pumperly-postgis-0 -- \
    psql -v ON_ERROR_STOP=1 -U pumperly -d pumperly < "$f"
done
```

Run it from a checkout of the repository, which holds the migration files.

Then restart the app, so its first scrapes run against the new tables:

```bash
kubectl rollout restart deployment/pumperly
```

### 5. Check it

```bash
helm test pumperly
kubectl logs deployment/pumperly -f
```

Without an ingress, reach the app through a port forward and open [http://127.0.0.1:3000](http://127.0.0.1:3000):

```bash
kubectl port-forward svc/pumperly 3000:3000
```

The log lines and the checks are the same as with Docker. See [What happens on first start](first-start.md).

## The schema

The app never creates its tables. The chart offers the `prisma-db-push` init container for that, on by default. It runs `npx prisma db push` on every pod start. Two facts make it the wrong tool for this schema:

- `prisma db push` builds the tables from `prisma/schema.prisma`. That file does not declare the `geom` column that holds each station's position, because Prisma has no type for it. Every scraper writes `geom`, so a schema built this way cannot store stations.
- The final stage of the [Dockerfile](https://github.com/GeiserX/Pumperly/blob/main/docker/Dockerfile) copies only `public/`, `.next/standalone` and `.next/static` into the image. It does not copy the `prisma/` directory or `prisma.config.ts`, which `prisma db push` reads.

Set `databaseInit.enabled: false` and apply the SQL migrations as in step 4. They create the `geom` column and its spatial indexes.

With `databaseInit.enabled: true`, the chart refuses to render when `replicaCount` is above 1, so that two pods never change the schema at once.

## Values that matter

The full [`values.yaml`](https://github.com/GeiserX/Pumperly/blob/main/charts/pumperly/values.yaml) is included at the end of this page. [`values.schema.json`](https://github.com/GeiserX/Pumperly/blob/main/charts/pumperly/values.schema.json) checks the type of each value when you install or upgrade, and rejects the wrong one before anything reaches the cluster. It checks types and a few ranges, such as ports and probe timings. It does not reject unknown keys, so a typo is ignored rather than reported.

### The app

| Value | Default | Sets |
|---|---|---|
| `image.repository` | `drumsergio/pumperly` | The app image. |
| `image.tag` | an older release | The app version. Set it. |
| `replicaCount` | `1` | Keep it at 1. The scrapers run inside the app, so a second replica scrapes every source twice. |
| `deploymentStrategy.type` | `Recreate` | Stops the old pod before the new one starts, so two scheduler copies never overlap. |
| `config.defaultCountry` | `"ES"` | `PUMPERLY_DEFAULT_COUNTRY` |
| `config.enabledCountries` | `""` (every scraper) | `PUMPERLY_ENABLED_COUNTRIES` |
| `config.defaultFuel` | `""` (per country) | `PUMPERLY_DEFAULT_FUEL` |
| `config.clusterStations` | `"true"` | `PUMPERLY_CLUSTER_STATIONS` |
| `config.scrapeIntervalHours` | `""` (built-in defaults) | `PUMPERLY_SCRAPE_INTERVAL_HOURS` |
| `config.evEnabled` | `""` (on) | `PUMPERLY_EV_ENABLED` |
| `resources` | 250m CPU and 256 MiB requested, 1 GiB limit | The app container. |

An empty string leaves the variable unset, so the app uses its own default. See [Environment variables](../reference/environment-variables.md).

### API keys and other settings

| Value | Sets |
|---|---|
| `apiKeys.tankerkoenig` | `TANKERKOENIG_API_KEY` |
| `apiKeys.openChargeMap` | `PUMPERLY_OCM_API_KEY` |
| `apiKeys.fuelpricesDk` | `FUELPRICES_DK_API_KEY` |
| `existingSecret` | Use your own Secret instead of the chart's. |
| `extraEnv`, `extraEnvFrom` | Any other variable. |

The chart stores the three keys above in its Secret. It has no value for other keys, such as `PUMPERLY_REVE_API_KEY` or `NSW_FUEL_API_KEY`, or for settings such as `PUMPERLY_DE_EV_SOURCE`. Pass them with `extraEnv`, or keep them in a Secret of your own and load it with `extraEnvFrom`:

```yaml
extraEnvFrom:
  - secretRef:
      name: pumperly-extra-keys
extraEnv:
  - name: PUMPERLY_SCRAPE_INTERVAL_FR
    value: "2"
```

With `existingSecret`, your Secret must hold `DATABASE_URL`. With the bundled PostGIS it must also hold `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`. It may hold `TANKERKOENIG_API_KEY`, `PUMPERLY_OCM_API_KEY` and `FUELPRICES_DK_API_KEY`. The app reads each key from the Secret only when the matching `apiKeys` value is non-empty.

### The database

| Value | Default | Sets |
|---|---|---|
| `postgis.enabled` | `true` | Run PostGIS in the release. |
| `postgis.auth.username`, `postgis.auth.database` | `pumperly` | The login and database name. |
| `postgis.auth.password` | `""` (generated) | The password. |
| `postgis.persistence.size` | `5Gi` | The database volume. |
| `postgis.resources` | 250m CPU and 512 MiB requested, 4 GiB limit | The PostGIS container. |
| `externalDatabase.url` | `""` | A full connection string for your own PostGIS. |
| `externalDatabase.host`, `port`, `user`, `password`, `database` | `""`, `5432` | The same, in parts, used when `url` is empty. |
| `waitForDatabase.enabled` | `true` | The `wait-for-database` init container. |
| `databaseInit.enabled` | `true` | The `prisma-db-push` init container. Set it to `false`. |

To use your own database, set `postgis.enabled: false` and fill `externalDatabase`. The database needs the PostGIS extension available. If you keep `waitForDatabase.enabled`, also set `externalDatabase.host`, even when you give a full `url`: the wait step probes that host.

### Routing and address search

| Value | Default | Sets |
|---|---|---|
| `valhalla.enabled` | `false` | Run Valhalla in the release. The app then gets `VALHALLA_URL` pointing at it. |
| `valhalla.tileUrls` | the Spain extract from Geofabrik | Which OpenStreetMap extract to build routing tiles from. |
| `valhalla.persistence.size` | `100Gi` | The tile volume. `existingClaim` reuses one you made. |
| `valhalla.resources` | 1 CPU and 4 GiB requested, 24 GiB limit | The build needs the memory. |
| `photon.enabled` | `false` | Run Photon in the release. The app then gets `PHOTON_URL` pointing at it. |
| `photon.image`, `photon.command`, `photon.args` | empty | Photon has no official image, so the chart has no default. With Photon on, the chart refuses to render until you set `photon.image.repository` and `photon.image.tag`. `command` and `args` are optional and override the image's own. |
| `photon.persistence.size` | `300Gi` | The index volume, mounted at `/photon/photon_data`. |
| `externalServices.valhallaUrl`, `externalServices.photonUrl` | `""` | Use a Valhalla or Photon that runs elsewhere. Ignored when the bundled one is on. |

!!! warning "Valhalla's first tile build and its health checks"
    The Valhalla liveness probe starts after 120 seconds and gives up after 10 failures 30 seconds apart. That is about 7 minutes, and these probe settings are fixed in the chart. A first tile build takes hours. If the pod restarts during the build, build the tiles outside the release and point `valhalla.persistence.existingClaim` at the volume that holds them. See [Routing with Valhalla](../configuration/routing-valhalla.md).

[Geocoding with Photon](../configuration/geocoding-photon.md) covers the Photon image and import.

### Health checks

The app's startup, liveness and readiness probes all request `GET /api/config`. That route does not query the database, so a passing probe means the web server is up, not that the scrapes work. Check `/api/stats` for that. See [Check that it works](first-start.md#check-that-it-works).

### Node drains and the disruption budget

A PodDisruptionBudget tells Kubernetes how many pods it may evict at once during voluntary disruptions, such as `kubectl drain` or a node upgrade. The chart's is off by default.

If you turn it on with `podDisruptionBudget.enabled: true`, the chart default `minAvailable: 1` applies. The app runs one replica, so evicting that pod would leave zero available. Kubernetes refuses the eviction, and a drain of that node waits forever.

The template uses `minAvailable` whenever it is set, and reads `maxUnavailable` only when it is not. To allow the drain, clear `minAvailable` and set `maxUnavailable`:

```yaml
podDisruptionBudget:
  enabled: true
  minAvailable: null
  maxUnavailable: 1
```

The app is then down while its pod moves to another node. The `Recreate` strategy makes an upgrade stop the pod the same way. A disruption budget cannot keep a single-replica app up, so leaving it off is also a sound choice.

## Before you expose it

The app speaks plain HTTP, has no login and sets no security headers. An Ingress, or whatever proxy sits in front of the Service, has to cover the rest. Three requirements come from how the app itself works:

| Requirement | Why |
|---|---|
| Replace `X-Forwarded-For` with the address the proxy saw | `/api/route`, `/api/route-stations` and `/api/route-detour` limit requests per client IP. They read the first `X-Forwarded-For` entry, then `X-Real-IP`. A controller that appends to a client-sent value lets the client pick its own IP and dodge the limit. A cloud load balancer in front of the controller counts as a proxy too: the controller should trust its address and no other. |
| Compress at the proxy | The app never compresses. Compression is off in [`next.config.ts`](https://github.com/GeiserX/Pumperly/blob/main/next.config.ts) so that streamed responses are not held back. |
| Do not buffer or compress `/api/route-detour` | It streams one JSON line per station as `application/x-ndjson`. Buffered or compressed, the browser sees nothing until the last line. The response sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-transform`. nginx-based controllers read the first header and stop buffering. Check what yours does. |

Check your ingress controller's documentation for how it sets `X-Forwarded-For`, compression and response buffering. Pass its settings through `ingress.annotations`, or in the controller's own configuration.

The rest of the list is the same as with Docker Compose. [Before you expose it](docker-compose.md#before-you-expose-it) on that page covers each item:

- [Security headers](docker-compose.md#security-headers): the Content Security Policy the app needs and the other headers to add.
- [Rate limits](docker-compose.md#rate-limits): `/api/geocode`, `/api/stations` and `/api/stations/nearest` have no limit inside the app.
- [The app still calls itself pumperly.com](docker-compose.md#the-app-still-calls-itself-pumperlycom): the canonical URL, sitemap, robots file, legal dialogs and some scraper `User-Agent` headers name pumperly.com. No chart value changes them.
- [Data licences on a public instance](docker-compose.md#data-licences-on-a-public-instance): Portugal's fuel data and Mapa REVE are non-commercial only, and most sources require credit.

The chart already keeps PostGIS, Valhalla and Photon on `ClusterIP` Services, so nothing outside the cluster reaches them unless you add a route.

## Upgrade

```bash
helm repo update
helm upgrade pumperly pumperly/pumperly -f my-values.yaml
```

Raise `image.tag` in your values file to move to a new app version. The chart restarts the app pod when its generated Secret changes. [Upgrading](../operations/upgrading.md) covers database changes between versions.

## The full values file

??? example "`charts/pumperly/values.yaml`"

    ```yaml
    --8<-- "charts/pumperly/values.yaml"
    ```
