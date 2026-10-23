-- Extra charges that come on top of an EV tariff's €/kWh, filled by the OCPDB
-- scraper, shaped as EvFees (src/types/station.ts), in the price's currency.
-- Nullable and metadata-only, like max_power_kw: fuel rows keep NULL.
ALTER TABLE "fuel_prices" ADD COLUMN IF NOT EXISTS "ev_fees" JSONB;
