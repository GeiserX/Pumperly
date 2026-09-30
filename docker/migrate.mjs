// Applies the SQL migrations under prisma/migrations to the database in
// DATABASE_URL, oldest folder first, skipping the ones already recorded. It
// records each one in Prisma's own history table, _prisma_migrations, with the
// checksum Prisma uses, so `npx prisma migrate deploy` and this script share
// one history and either can take over from the other.
//
// The image carries this file and the migrations, so it needs no checkout:
//   docker run --rm -e DATABASE_URL=... drumsergio/pumperly:<tag> node migrate.mjs
// From a checkout: node docker/migrate.mjs (reads prisma/migrations in the cwd).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const HISTORY_TABLE = `CREATE TABLE "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

// The row `prisma migrate deploy` writes for an applied migration.
const RECORD = `INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count)
  VALUES ($1, $2, $3, now(), 1)`;

const log = (msg) => console.log(`migrate: ${msg}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; copy .env.example to .env");
  const dir = resolve(process.env.MIGRATIONS_DIR ?? "prisma/migrations");

  const names = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "migration.sql")))
        .map((d) => d.name)
        .sort()
    : [];
  if (names.length === 0) throw new Error(`no migrations found in ${dir}; is prisma/migrations there?`);
  const fileOf = (name) => readFileSync(join(dir, name, "migration.sql"));
  const record = (name) => [randomUUID(), sha256(fileOf(name)), name];

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const one = async (sql, params) => (await client.query(sql, params)).rows[0];

    const { exists } = await one(`SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`);
    if (!exists) {
      const { any } = await one(
        `SELECT to_regclass('public.stations') IS NOT NULL OR to_regclass('public.fuel_prices') IS NOT NULL AS any`,
      );
      if (any) {
        // A schema built by hand, with no history. Only a complete 0_init counts
        // as applied: both tables and the PostGIS column the scrapers write.
        const { complete } = await one(
          `SELECT to_regclass('public.stations') IS NOT NULL
              AND to_regclass('public.fuel_prices') IS NOT NULL
              AND EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'stations' AND column_name = 'geom') AS complete`,
        );
        if (!complete) {
          throw new Error("the database has part of the schema and no history; repair it or start from an empty volume");
        }
        // This is `prisma migrate resolve --applied 0_init`; the later
        // migrations are written to be safe to run again, so they run below.
        log("existing schema with no history, recording 0_init as applied");
        await client.query("BEGIN");
        await client.query(HISTORY_TABLE);
        await client.query(RECORD, record("0_init"));
        await client.query("COMMIT");
      } else {
        await client.query(HISTORY_TABLE);
      }
    }

    // A migration Prisma started and never finished needs a person: running
    // its SQL again would leave the failed row behind, and Prisma refuses (P3009).
    const { failed } = await one(
      `SELECT string_agg(migration_name, ', ') AS failed FROM "_prisma_migrations"
        WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    );
    if (failed) {
      throw new Error(`unfinished migration(s) in the history: ${failed}. Resolve them with \`npx prisma migrate resolve\` first.`);
    }

    let applied = 0;
    for (const name of names) {
      const { done } = await one(
        `SELECT count(*)::int AS done FROM "_prisma_migrations"
          WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        [name],
      );
      if (done) continue;
      log(`applying ${name}`);
      // One transaction per migration: the SQL and its history row land together or not at all.
      await client.query("BEGIN");
      try {
        await client.query(fileOf(name).toString("utf8"));
        await client.query(RECORD, record(name));
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw new Error(`${name} failed: ${err.message}`);
      }
      applied++;
    }
    log(`${applied} migration(s) applied, schema up to date`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`migrate: ${err.message}`);
  process.exit(1);
});
