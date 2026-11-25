-- Scraper runs now write only the prices and stations that changed, so an
-- unchanged run costs reads, not row rewrites (see src/scrapers/base.ts).
--
-- Fail fast instead of queueing the API behind this migration: DROP INDEX
-- needs an exclusive lock on fuel_prices, and a scraper transaction of the
-- release being replaced can hold its lock for up to 120 s. On timeout the
-- migration rolls back whole, and the next migrate run (or pod start) retries.
SET LOCAL lock_timeout = '10s';

-- When each source last confirmed its prices in each country. Readers show
-- GREATEST(fuel_prices.reported_at, confirmed_at), so a price that did not
-- change still reads as fresh. NULL means the source's rows carry their own
-- upstream time (OCPDB). No backfill: with every marker NULL, readers return
-- exactly what they returned before.
CREATE TABLE IF NOT EXISTS "price_sources" (
    "country" VARCHAR(2) NOT NULL,
    "source" VARCHAR(50) NOT NULL,
    "confirmed_at" TIMESTAMPTZ,

    CONSTRAINT "price_sources_pkey" PRIMARY KEY ("country", "source")
);

-- A changed price also moves reported_at. With reported_at in the index,
-- that update could never be HOT (heap-only, no index write). Readers look up
-- one (station, fuel) at a time, 1-2 rows, so they need no index order.
-- Not unique on purpose: a rollback to the previous release, which deletes
-- and reinserts every price, keeps working.
CREATE INDEX IF NOT EXISTS "fuel_prices_station_id_fuel_type_idx" ON "fuel_prices"("station_id", "fuel_type");
DROP INDEX IF EXISTS "fuel_prices_station_id_fuel_type_reported_at_idx";
