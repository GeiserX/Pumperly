# Data model

This page describes the database Pumperly stores its data in: the two tables, their columns and indexes, and what the `external_id` and `source` columns mean. It is for contributors writing scrapers and for operators who query their own database.

Pumperly uses PostgreSQL with the [PostGIS](<https://postgis.net>) extension. **PostGIS** adds geographic types and functions, so the database itself can answer "which stations are inside this box" or "within 5 km of this route". Everything Pumperly shows lives in two tables:

- `stations`: one row per fuel station or EV charger.
- `fuel_prices`: one row per price, pointing at a station.

```
erDiagram
    stations ||--o{ fuel_prices : "has prices"
    stations {
        uuid id PK
        text external_id
        varchar country
        text name
        text brand
        text address
        text city
        text province
        varchar station_type
        geometry geom
        smallint max_power_kw
        timestamptz created_at
        timestamptz updated_at
    }
    fuel_prices {
        bigint id PK
        uuid station_id FK
        varchar fuel_type
        decimal price
        varchar currency
        timestamptz reported_at
        varchar source
        jsonb ev_fees
    }
```

There are no user tables. Pumperly has no accounts, and the database holds nothing about visitors.

## Where the schema is defined

Two places in the repository describe these tables, and they are not identical.

- [`prisma/schema.prisma`](<https://github.com/GeiserX/Pumperly/blob/main/prisma/schema.prisma>) is the Prisma schema. The Prisma client used by the app is generated from it.
- [`prisma/migrations/`](<https://github.com/GeiserX/Pumperly/tree/main/prisma/migrations>) holds the SQL that creates the tables. It includes what the Prisma schema language cannot express.

| Item | `schema.prisma` | Migrations |
| --- | --- | --- |
| `stations.geom` | Not declared | `geometry(Point, 4326)` |
| The two GiST indexes on `geom` | Not declared | Created |
| Default for `stations.id` | `@default(uuid())`, filled in by the Prisma client | `DEFAULT gen_random_uuid()`, filled in by the database |
| `fuel_prices.price` | `Decimal(10, 3)` | `DECIMAL(6,3)` in the first migration, widened to `DECIMAL(10,3)` by a later one |

> [!WARNING]
>
> **Scrapers write with raw SQL**
>
> Scrapers insert stations and prices with SQL, not through the Prisma client. Their station insert sets `geom` and leaves `id` to the database default. A database therefore needs the `geom` column and the `id` default from the migrations, or every scraper insert fails. The map and route queries also rely on the GiST indexes to stay fast. Tools that build the tables from `schema.prisma` alone, such as `prisma db push`, create none of these.

The shipped files, included here word for word:

```
generator client {
  provider        = "prisma-client"
  output          = "../src/generated/prisma"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  extensions = [postgis]
}

model Station {
  id          String   @id @default(uuid()) @db.Uuid
  externalId  String   @map("external_id")
  country     String   @db.VarChar(2)
  name        String
  brand       String?
  address     String
  city        String
  province    String?
  stationType String   @default("fuel") @map("station_type") @db.VarChar(20)
  /// Highest single-connector power (kW) for EV chargers; null when unknown or not a charger.
  maxPowerKw  Int?     @map("max_power_kw") @db.SmallInt
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz

  prices FuelPrice[]

  @@unique([externalId, country])
  @@map("stations")
}

model FuelPrice {
  id         BigInt   @id @default(autoincrement())
  stationId  String   @map("station_id") @db.Uuid
  fuelType   String   @map("fuel_type") @db.VarChar(20)
  price      Decimal  @db.Decimal(10, 3)
  currency   String   @default("EUR") @db.VarChar(3)
  reportedAt DateTime @default(now()) @map("reported_at") @db.Timestamptz
  source     String   @db.VarChar(50)
  /// EV only: fees on top of the per-kWh price, shaped as EvFees (src/types/station.ts).
  evFees     Json?    @map("ev_fees")

  station Station @relation(fields: [stationId], references: [id], onDelete: Cascade)

  @@index([stationId, fuelType, reportedAt(sort: Desc)])
  @@map("fuel_prices")
}
```

```
-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateTable
CREATE TABLE "stations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "external_id" TEXT NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT,
    "station_type" VARCHAR(20) NOT NULL DEFAULT 'fuel',
    "geom" geometry(Point, 4326),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_prices" (
    "id" BIGSERIAL NOT NULL,
    "station_id" UUID NOT NULL,
    "fuel_type" VARCHAR(20) NOT NULL,
    "price" DECIMAL(6,3) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "reported_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(50) NOT NULL,

    CONSTRAINT "fuel_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique station per country source
CREATE UNIQUE INDEX "stations_external_id_country_key" ON "stations"("external_id", "country");

-- CreateIndex: spatial GiST on geometry
CREATE INDEX "stations_geom_idx" ON "stations" USING GIST ("geom");

-- CreateIndex: fast price lookups
CREATE INDEX "fuel_prices_station_id_fuel_type_reported_at_idx" ON "fuel_prices"("station_id", "fuel_type", "reported_at" DESC);

-- AddForeignKey
ALTER TABLE "fuel_prices" ADD CONSTRAINT "fuel_prices_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

```
-- Functional GiST so ST_DWithin(geom::geography, …) is index-backed.
-- NOTE: CONCURRENTLY cannot run inside Prisma's migration transaction.
-- On production (~145K rows) apply this out-of-band via psql to avoid locking writes:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS stations_geom_geography_idx ON stations USING GIST ((geom::geography));
CREATE INDEX IF NOT EXISTS stations_geom_geography_idx ON stations USING GIST ((geom::geography));
```

```
-- 0_init created fuel_prices.price as DECIMAL(6,3), which cannot hold 1,000 or
-- more. schema.prisma has always declared DECIMAL(10,3), and the per-currency
-- price bands in src/scrapers/base.ts accept values up to 20,000 (ARS) and
-- 2,000 (HUF), so a database built from the migrations rejected those rows.
-- Databases created with `prisma db push` already have DECIMAL(10,3); running
-- this on them changes nothing.
ALTER TABLE "fuel_prices" ALTER COLUMN "price" TYPE DECIMAL(10,3);
```

```
-- Highest single-connector power (kW) for EV chargers, filled by the OCM, REVE
-- and BNetzA scrapers. Nullable: fuel stations and chargers with no published
-- power keep NULL. ADD COLUMN with no default is metadata-only, so it is
-- instant even on a full table.
ALTER TABLE "stations" ADD COLUMN IF NOT EXISTS "max_power_kw" SMALLINT;
```

```
-- Extra charges that come on top of an EV tariff's €/kWh, filled by the OCPDB
-- scraper, shaped as EvFees (src/types/station.ts), in the price's currency.
-- Nullable and metadata-only, like max_power_kw: fuel rows keep NULL.
ALTER TABLE "fuel_prices" ADD COLUMN IF NOT EXISTS "ev_fees" JSONB;
```

## `stations`

One row per place: a fuel station, an EV charger, or a site that is both.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | `uuid` | No | Pumperly's own id for the row. Generated by the database. Prices point at it. |
| `external_id` | `text` | No | The source's id for the station. See [`external_id`](<#external_id>). |
| `country` | `varchar(2)` | No | ISO 3166-1 alpha-2 code of the scraper that wrote the row. It is not worked out from the coordinates. |
| `name` | `text` | No | Display name. Scrapers build one when the source has none, for example from the brand and the town. |
| `brand` | `text` | Yes | Brand or network, such as a fuel company or a charge point operator. `null` when the source gives none. |
| `address` | `text` | No | Street address. An empty string when the source has none. |
| `city` | `text` | No | Town or municipality. An empty string when the source has none. |
| `province` | `text` | Yes | Region, state or county, when the source gives one. |
| `station_type` | `varchar(20)` | No | `fuel`, `ev_charger` or `both`. Defaults to `fuel`. |
| `geom` | `geometry(Point, 4326)` | Yes | The position, as a PostGIS point in WGS84 longitude and latitude. Scrapers always set it. |
| `max_power_kw` | `smallint` | Yes | EV chargers: highest single-connector power in kW, set by the OCPDB, BNetzA, OCM and REVE scrapers. `null` for fuel stations and chargers with no published power. |
| `created_at` | `timestamptz` | No | When the row was first inserted. Never changed afterwards. |
| `updated_at` | `timestamptz` | No | When a scraper run last wrote this station. Every successful upsert sets it to the current time, even when nothing changed. |

`station_type` decides how the app queries a station:

| Value | Written by | Shown for |
| --- | --- | --- |
| `fuel` | Fuel price scrapers | Fuel searches, joined to `fuel_prices` |
| `ev_charger` | OCPDB, OpenChargeMap, Mapa REVE and BNetzA scrapers | The `EV` filter, with the newest `EV` price when one exists |
| `both` | Accepted by the scraper contract. No built-in scraper writes it. | The `EV` filter, and fuel searches when it has prices |

`geom` stores longitude first, as PostGIS does. To read it back as numbers, use `ST_X(geom)` for longitude and `ST_Y(geom)` for latitude.

## `fuel_prices`

One row per price of one fuel at one station.

| Column | Type | Null | Meaning |
| --- | --- | --- | --- |
| `id` | `bigint` | No | Row id, from a sequence. |
| `station_id` | `uuid` | No | The station, `stations.id`. Deleting a station deletes its prices. |
| `fuel_type` | `varchar(20)` | No | A fuel code such as `E5`, `E10` or `B7`. See [Fuel types](<https://geiserx.github.io/Pumperly/reference/fuel-types/index.md>). The database does not check the value. The `RawFuelPrice` type limits scrapers to codes from the list when the code is compiled. |
| `price` | `decimal` | No | Price per litre in `currency`, with three decimals. Gas fuels sold by weight, such as CNG in some countries, are per kilogram. `EV` prices are per kWh. |
| `currency` | `varchar(3)` | No | ISO 4217 code of `price`, such as `EUR` or `SEK`. Defaults to `EUR`. Scrapers always set it. |
| `reported_at` | `timestamptz` | No | When Pumperly wrote the price, not when the source last changed it. The OCPDB scraper is the exception: it writes when the tariff's operator feed last refreshed. |
| `source` | `varchar(50)` | No | The name of the scraper source that wrote the row. See [`source`](<#source>). |
| `ev_fees` | `jsonb` | Yes | `EV` rows only: charges on top of the per-kWh price, in `currency`. See [`ev_fees`](<#ev_fees>). `null` for fuel rows and for tariffs with no extra charges. |

An `EV` search queries stations by `station_type`, then joins each one to its newest `EV` row here, if any. Only the [OCPDB scraper](<https://geiserx.github.io/Pumperly/data/ev-sources/#ocpdb>) writes `EV` rows, so only German chargers have prices. Every other charger has no rows in this table and shows unpriced.

### `ev_fees`

The JSON object holds the parts of a charging tariff that a per-kWh price cannot express. Every field is optional.

| Field | Meaning |
| --- | --- |
| `sessionFee` | A fixed fee per charging session. When the fee varies, this is the highest one, and that is the value cost estimates use. |
| `sessionFeeRules` | Present only when the session fee varies. A list of `{ fee, from?, to?, days?, other? }`: `from` and `to` are local `HH:MM` times, `days` are ISO weekdays (1 is Monday), and `other: true` means further conditions apply. |
| `perMinute` | A blocking fee per minute. |
| `afterMin` | Minutes into the session at which `perMinute` starts. `0` means from the start. |

Nothing stops two rows for the same station and fuel. Readers take the newest one by `reported_at`. The example query [below](<#reading-the-newest-price>) shows the pattern.

## Indexes and constraints

| Name | On | Used for |
| --- | --- | --- |
| `stations_pkey` | `stations (id)` | Primary key. |
| `stations_external_id_country_key` | `stations (external_id, country)`, unique | The conflict target of the scrapers' `INSERT ... ON CONFLICT`. It makes a station's identity the pair of its source id and its country. |
| `stations_geom_idx` | `stations USING GIST (geom)` | Bounding-box searches on the map (`ST_Within` an envelope), radius searches for the nearest stations, and the fast `&&` pre-filter of the route search. |
| `stations_geom_geography_idx` | `stations USING GIST ((geom::geography))` | Distance in metres along a route (`ST_DWithin` on `geography`). |
| `fuel_prices_pkey` | `fuel_prices (id)` | Primary key. |
| `fuel_prices_station_id_fuel_type_reported_at_idx` | `fuel_prices (station_id, fuel_type, reported_at DESC)` | Finding the newest price of one fuel at one station. |
| `fuel_prices_station_id_fkey` | `fuel_prices.station_id` references `stations.id` | `ON DELETE CASCADE` and `ON UPDATE CASCADE`: a deleted station takes its prices with it. |

A **GiST index** is PostgreSQL's index type for geometric data. It lets a spatial query skip rows far from the area it asks about. The second GiST index is built on the expression `geom::geography`, so a query written with that exact cast can use it. The migration notes that on a large existing table you may prefer to build it by hand with `CREATE INDEX CONCURRENTLY`, which does not block writes.

## `external_id`

`external_id` is the station's id in its upstream source. It is how a scraper recognises a station it wrote on an earlier run. Each run upserts on `(external_id, country)`: a known pair updates the existing row, a new pair inserts a new one.

That makes two properties essential:

- **Stable.** The same station gets the same `external_id` on every run. If it changes, a new row with a new `id` is inserted. For a fuel station, the old row loses its prices and the orphan cleanup deletes it. An old EV charger row stays unless its scraper removes it.
- **Unique within the country, across all sources.** The unique index covers `external_id` and `country` only, not the source. After the station upsert, a run also maps its prices to stations by `external_id` within the country. Two sources that used the same id in one country would share, and overwrite, one row.

To keep sources apart, scrapers prefix the upstream id with a short tag. Some examples from the current scrapers:

| Source | `external_id` form |
| --- | --- |
| `bensinpriser` (Sweden) | `se-bp-<station id>` |
| `nsw_fuelcheck` (New South Wales) | `nsw_<station code>` |
| `ocm` (OpenChargeMap, every country) | `ocm-<POI id>` |
| `reve` (Mapa REVE, Spain) | `reve-<location id>` |
| `bnetza` (BNetzA register, Germany) | `bnetza-<latitude>_<longitude>`, rounded to 5 decimals. The register has one row per charging device, and the scraper merges the rows at one position into one station. |
| `ocpdb` (Open ChargePoint Database, Germany) | `ocpdb-<latitude>_<longitude>`, rounded to 5 decimals, from the location that anchors the pin. Locations within 25 m of each other merge into one station. |
| `miteco` (Spain) | The ministry's station id, with no prefix |

Some older scrapers use the upstream id without a prefix, as `miteco` does. A new scraper should use a prefix. [Adding a country](<https://geiserx.github.io/Pumperly/data/adding-a-country/#choosing-source-and-externalid>) gives the rules.

`stations` has no `source` column. For EV chargers, most of which have no prices, the `external_id` prefix is the only record of where a row came from. That is how the EV scrapers find the rows of the sources they replace: Mapa REVE deletes `external_id LIKE 'ocm-%'` in Spain, and OCPDB and BNetzA each delete the other German prefixes among `ocm-`, `bnetza-` and `ocpdb-`.

## `source`

`source` is the name of the scraper that wrote a price row, such as `miteco`, `cma`, `fuelo_pl` or `bensinpriser`. It lives on `fuel_prices` only.

Every scraper run replaces exactly the price rows that carry its own `source` for stations in its own country. It never touches another source's rows. Two consequences:

- One source name can serve several countries. The Netherlands, Belgium and Luxembourg scrapers all write `anwb`, and none of them deletes the others' prices, because the replace is limited to one country.
- When a source is retired, its rows stay until something deletes them. The replacement scraper has to do that itself. [How scrapers work](<https://geiserx.github.io/Pumperly/data/how-scrapers-work/#handing-a-country-over-to-a-new-source>) shows the pattern.

## How rows change over time

Only scrapers write to these tables. The app's API routes only read them.

| Event | Effect on `stations` | Effect on `fuel_prices` |
| --- | --- | --- |
| A source lists a new station | Row inserted | Its prices inserted |
| A source lists a known station again | Name, brand, address, city, province, type and position overwritten, `updated_at` set to now | This source's rows deleted and inserted fresh, with a new `reported_at` |
| A source stops listing a fuel station | Deleted at the end of the run, once no source has a price for it | Its rows from this source deleted |
| A source stops listing an EV charger | Kept, unless the EV scraper removes it itself | None |
| A run ends in a `Fatal` error | Unchanged, or partly updated if the error came after some station batches | Unchanged, unless the error came after the price replace committed |
| A station batch fails | The other batches are written. No station is deleted this run. | Replaced as usual for the stations the database knows |

The full sequence, including the guards that stop a bad run from deleting data, is in [How scrapers work](<https://geiserx.github.io/Pumperly/data/how-scrapers-work/index.md>).

Prices are replaced, not appended. The database holds the current price per station, fuel and source, not a price history.

## Reading the newest price

To query the data yourself, join each station to its newest price for one fuel. This is the pattern the app's own station endpoints use:

```
SELECT s.name, s.brand, s.city, fp.price, fp.currency, fp.reported_at
FROM stations s
JOIN LATERAL (
  SELECT price, currency, reported_at
  FROM fuel_prices
  WHERE station_id = s.id
    AND fuel_type = 'B7'
  ORDER BY reported_at DESC NULLS LAST
  LIMIT 1
) fp ON true
WHERE ST_DWithin(
  s.geom::geography,
  ST_SetSRID(ST_MakePoint(-3.70, 40.42), 4326)::geography,
  5000
)
ORDER BY fp.price
LIMIT 10;
```

This lists the ten cheapest diesel prices within 5 km of a point. `ST_MakePoint` takes longitude first. The lateral subquery can use the `fuel_prices` index, and the `ST_DWithin` on `geom::geography` can use the geography index.

For the same data over HTTP, see the [HTTP API](<https://geiserx.github.io/Pumperly/reference/api/index.md>).
