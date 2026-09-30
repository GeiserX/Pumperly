-- Highest single-connector power (kW) for EV chargers, filled by the OCM, REVE
-- and BNetzA scrapers. Nullable: fuel stations and chargers with no published
-- power keep NULL. ADD COLUMN with no default is metadata-only, so it is
-- instant even on a full table.
ALTER TABLE "stations" ADD COLUMN IF NOT EXISTS "max_power_kw" SMALLINT;
