-- 0_init created fuel_prices.price as DECIMAL(6,3), which cannot hold 1,000 or
-- more. schema.prisma has always declared DECIMAL(10,3), and the per-currency
-- price bands in src/scrapers/base.ts accept values up to 20,000 (ARS) and
-- 2,000 (HUF), so a database built from the migrations rejected those rows.
-- Databases created with `prisma db push` already have DECIMAL(10,3); running
-- this on them changes nothing.
ALTER TABLE "fuel_prices" ALTER COLUMN "price" TYPE DECIMAL(10,3);
