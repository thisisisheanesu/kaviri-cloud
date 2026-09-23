#!/usr/bin/env bash
# Rebuild the database from nothing: drop what the migrations own, apply all of them in
# order, and seed demo data.
#
# This exists because the alternative is a database that drifts. A schema half-migrated by
# hand during an afternoon's debugging is a schema nobody can reproduce, and the first
# person to notice is whoever writes the next migration against it. Resetting has to be
# one command and it has to be fast, or people will patch instead.
#
# It refuses to touch a database holding anything it does not recognise as its own. The
# guard is deliberately blunt: the accident this prevents is somebody exporting a
# production connection string in the shell where they then run a reset, and a blunt guard
# is the only kind that survives being in a hurry.
#
#   DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres scripts/reset.sh
#   SUPABASE_PROJECT_REF=xxxxxxxxxxxx scripts/reset.sh
#
#   --no-seed    schema only, which is what CI wants before running the tests
#   --force      skip the guard, for the one case where you really are resetting a
#                database that has real orgs in it and have decided that is fine

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

seed=1
force=0
for arg in "$@"; do
  case "$arg" in
    --no-seed) seed=0 ;;
    --force) force=1 ;;
    *) echo "reset: unknown argument $arg" >&2; exit 2 ;;
  esac
done

if [ -z "${DATABASE_URL:-}" ] && [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "reset: set DATABASE_URL or SUPABASE_PROJECT_REF" >&2
  exit 2
fi

run() { python3 scripts/run-sql.py "$@"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ---------------------------------------------------------------------------
# The guard
# ---------------------------------------------------------------------------

if [ "$force" -eq 0 ]; then
  cat >"$tmp/guard.sql" <<'SQL'
do $$
declare
  n bigint;
begin
  -- to_regclass rather than a catalogue join, so that a database which has never had the
  -- migrations applied is a normal first run rather than an error.
  if to_regclass('public.orgs') is null then
    raise notice 'reset: no existing schema, this is a first run';
    return;
  end if;

  select count(*) into n from public.orgs
   where slug not in ('acme', 'globex');

  if n > 0 then
    raise exception
      'refusing to reset: this database holds % org(s) that are not demo data', n
      using hint = 'if you meant it, pass --force';
  end if;
end
$$;
SQL
  run --quiet "$tmp/guard.sql"
fi

# ---------------------------------------------------------------------------
# Drop
# ---------------------------------------------------------------------------

# Dropping the schemas rather than the objects, because a DROP TABLE list is a second
# place the schema is written down and it is always the one that goes stale. public is
# recreated immediately with the grants a stock Supabase database ships with, since
# dropping it takes those with it.
#
# auth.users is not ours and is not dropped. The rows the seed added are removed by the
# seed itself, so the auth schema is left exactly as Supabase manages it.
cat >"$tmp/drop.sql" <<'SQL'
-- pg_cron jobs outlive the functions they call, so an unscheduled reset leaves a cron
-- entry calling a function that no longer exists, which fills the log with errors every
-- minute until somebody investigates.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname)
       from cron.job
      where jobname in ('kaviri-reap-leases', 'kaviri-expire-artifacts');
  end if;
exception
  when others then
    raise notice 'could not unschedule cron jobs: %', sqlerrm;
end
$$;

drop schema if exists app cascade;
drop schema if exists public cascade;

create schema public;
grant usage on schema public to public;
grant create on schema public to public;
SQL

echo "reset: dropping"
run --quiet "$tmp/drop.sql"

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

echo "reset: applying migrations"
# Sorted by filename, which is the order the migrations are numbered in and the only order
# they are known to apply in.
run supabase/migrations/*.sql

if [ "$seed" -eq 1 ]; then
  echo "reset: seeding"
  run supabase/seed.sql
fi

echo "reset: done"
