-- Scrapers now write a price or a station only when its content changed,
-- instead of rewriting every row of a country on every run. This migration
-- gives the price table what that needs. Every statement is safe to run again.

-- Hold off concurrent writers between the dedupe and the unique index, so an
-- old scraper still running during the upgrade cannot slip a duplicate in.
LOCK TABLE "fuel_prices" IN SHARE ROW EXCLUSIVE MODE;

-- One row per station, fuel and source. Keep the newest reported_at, ties going
-- to the lowest id: the row the readers already show today.
DELETE FROM "fuel_prices" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "station_id", "fuel_type", "source"
      ORDER BY "reported_at" DESC NULLS LAST, "id"
    ) AS rn
    FROM "fuel_prices"
  ) ranked
  WHERE rn > 1
);

-- The key the scrapers upsert on.
CREATE UNIQUE INDEX IF NOT EXISTS "fuel_prices_station_id_fuel_type_source_key"
  ON "fuel_prices" ("station_id", "fuel_type", "source");

-- The new key leads with (station_id, fuel_type), so it serves the readers'
-- per-station lookups. Kept as its own statement so it can be reverted alone.
DROP INDEX IF EXISTS "fuel_prices_station_id_fuel_type_reported_at_idx";

-- NULL now means "dated by its source's last successful run" (scrape_runs).
-- A row keeps its own reported_at only when the upstream dates it.
ALTER TABLE "fuel_prices" ALTER COLUMN "reported_at" DROP NOT NULL;
ALTER TABLE "fuel_prices" ALTER COLUMN "reported_at" DROP DEFAULT;

-- Leave room on each page so a changed price can be a HOT update. Applies to
-- pages written from now on; existing pages fill to 90% as rows get rewritten.
ALTER TABLE "fuel_prices" SET (fillfactor = 90);

-- When each source last finished a successful run in each country. Written in
-- the same transaction as that run's prices.
CREATE TABLE IF NOT EXISTS "scrape_runs" (
  "country" VARCHAR(2) NOT NULL,
  "source" VARCHAR(50) NOT NULL,
  "last_success_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "scrape_runs_pkey" PRIMARY KEY ("country", "source")
);
