#!/bin/sh
# Applies prisma/migrations/*/migration.sql to the database in DATABASE_URL,
# oldest folder first, skipping the ones already recorded. It records each one
# in Prisma's own history table, _prisma_migrations, with the checksum Prisma
# uses, so `npx prisma migrate deploy` and this script share one history and
# either can take over from the other.
set -eu

url="${DATABASE_URL:?DATABASE_URL is not set; copy .env.example to .env}"
url="${url%%\?*}" # psql rejects Prisma's query parameters, such as ?schema=
dir="${MIGRATIONS_DIR:-/migrations}"

sql() { psql "$url" -v ON_ERROR_STOP=1 -qtAX "$@"; }

record() { # record <name> <file>: the row `prisma migrate deploy` writes
  echo "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, finished_at, applied_steps_count)
        VALUES ('$(cat /proc/sys/kernel/random/uuid)', '$(sha256sum "$2" | cut -d' ' -f1)', '$1', now(), 1);"
}

if [ "$(sql -c "SELECT to_regclass('public._prisma_migrations') IS NULL")" = t ]; then
  create='CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
  );'
  if [ "$(sql -c "SELECT to_regclass('public.stations') IS NOT NULL")" = t ]; then
    # A schema built by hand, with no history: 0_init already ran. This is
    # `prisma migrate resolve --applied 0_init`; the later migrations are
    # written to be safe to run again, so they run below.
    echo "migrate: existing schema with no history, recording 0_init as applied"
    sql -1 -c "$create" -c "$(record 0_init "$dir/0_init/migration.sql")"
  else
    sql -c "$create"
  fi
fi

ls "$dir"/*/migration.sql >/dev/null 2>&1 || {
  echo "migrate: no migrations found in $dir; is prisma/migrations mounted?" >&2
  exit 1
}

applied=0
for path in "$dir"/*/migration.sql; do
  [ -f "$path" ] || continue
  name=$(basename "$(dirname "$path")")
  done=$(sql -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '$name' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
  [ "$done" = 0 ] || continue
  echo "migrate: applying $name"
  sql -1 -f "$path" -c "$(record "$name" "$path")"
  applied=$((applied + 1))
done
echo "migrate: $applied migration(s) applied, schema up to date"
