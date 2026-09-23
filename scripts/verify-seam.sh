#!/usr/bin/env bash
# The seam, verified against the database rather than against the source.
#
# scripts/check-seam.sh reads the files in this repository and asserts that none of them
# contains billing logic. This script asserts the other half, which the source alone
# cannot prove: that the schema those files actually produce has no billing surface in it,
# and that the two objects the private service is allowed to touch are exactly the two
# objects it is allowed to touch.
#
# Both halves are needed. A migration can reference no billing schema and still create
# one, through a DO block, an EXECUTE of a composed string, or an extension that brings
# its own tables. And a column named innocently in the DDL is still a price if it holds
# one. So this runs after the migrations are applied and interrogates the catalogue.
#
# What it enforces:
#   1. No schema named for billing exists.
#   2. No table, view, column, function, type or enum label in the open schemas is about
#      money.
#   3. org_entitlements is the ONLY table the billing service may write, every one of its
#      columns is a limit, and every key inside its extra_limits jsonb is a limit too.
#      The jsonb half matters because it is the one part of the write surface that a
#      column-name check cannot see.
#   4. v_org_usage_month is the ONLY usage surface it may read, and it exposes quantities
#      and no money.
#   5. The open service really does run unmetered with no billing service present: a fresh
#      org gets null limits and the platform ceilings and nothing else.
#
# Usage, against whichever database the migrations were applied to:
#
#   DATABASE_URL=postgres://...            scripts/verify-seam.sh
#   SUPABASE_PROJECT_REF=xxxxxxxxxxxx      scripts/verify-seam.sh
#
# Exits non-zero and names the offending object if the seam has been crossed.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ -z "${DATABASE_URL:-}" ] && [ -z "${SUPABASE_PROJECT_REF:-}" ]; then
  echo "verify-seam: set DATABASE_URL or SUPABASE_PROJECT_REF" >&2
  exit 2
fi

# The static half first, because it is instant and because a failure there explains a
# failure here. Running the source check from the schema check means CI has one seam job
# rather than two that can be enabled separately and then forgotten separately.
if [ -x scripts/check-seam.sh ]; then
  scripts/check-seam.sh
fi

sql="$(mktemp)"
trap 'rm -f "$sql"' EXIT

cat >"$sql" <<'SQL'
-- Every assertion is phrased so that the failure message names the object that broke the
-- seam. "The seam is broken" sends somebody hunting; "org_entitlements.unit_amount is
-- about money" does not.
do $$
declare
  bad text;
  n bigint;
  -- One word list, used for column names and for jsonb keys alike. It is declared once
  -- rather than written out twice because the two checks are the same question asked of
  -- schema and of data, and a word added to one and forgotten in the other would leave
  -- exactly the gap the jsonb check exists to close.
  money_word constant text :=
    '(^|_)(price|amount|cost|currency|invoice|stripe|coupon|discount|subscription|mrr|arr|cents|tax_rate|payment|charge)($|_)';
begin
  -- 1. A schema named for billing.
  select string_agg(nspname, ', ') into bad
    from pg_namespace
   where nspname ~* '^(billing|stripe|payments?|invoicing)$';
  if bad is not null then
    raise exception 'a billing schema exists in the open database: %', bad;
  end if;

  -- 2. Relations in the open schemas whose names are about money.
  select string_agg(format('%I.%I', schemaname, tablename), ', ') into bad
    from pg_tables
   where schemaname in ('public', 'app')
     and tablename ~* '(price|invoice|stripe|coupon|discount|subscription|payment|charge|credit_note|tax_rate)';
  if bad is not null then
    raise exception 'tables about money exist in the open database: %', bad;
  end if;

  -- Columns, which is where a price actually hides. Checked across both open schemas
  -- rather than only on org_entitlements, because a price smuggled onto render_jobs is
  -- the same breach.
  select string_agg(format('%I.%I.%I', table_schema, table_name, column_name), ', ') into bad
    from information_schema.columns
   where table_schema in ('public', 'app')
     and column_name ~* money_word;
  if bad is not null then
    raise exception 'columns about money exist in the open database: %', bad;
  end if;

  select string_agg(format('%I.%I', n.nspname, p.proname), ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app')
     and p.proname ~* '(price|invoice|stripe|charge|refund|coupon|subscription|payment)';
  if bad is not null then
    raise exception 'functions about money exist in the open database: %', bad;
  end if;

  -- Enum labels, because a state machine that can be 'past_due' is a billing state
  -- machine however the type is named.
  select string_agg(format('%I.%I = %L', n.nspname, t.typname, e.enumlabel), ', ') into bad
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
   where n.nspname in ('public', 'app')
     and e.enumlabel ~* '(paid|unpaid|past_due|trialing|incomplete|refunded|delinquent)';
  if bad is not null then
    raise exception 'enum labels about money exist in the open database: %', bad;
  end if;

  -- 3. The write surface. Named explicitly rather than derived, because the value of this
  -- assertion is that adding a second billing-written table forces somebody to come here
  -- and change the list, in a diff a reviewer will see.
  if to_regclass('public.org_entitlements') is null then
    raise exception 'org_entitlements is missing; the billing write surface does not exist';
  end if;

  -- Every column of it must be a limit, an identifier, or bookkeeping. Anything else is
  -- presumed to be money until somebody widens this list on purpose.
  select string_agg(column_name, ', ') into bad
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'org_entitlements'
     and column_name not in (
       'org_id', 'plan_code', 'extra_limits', 'source', 'updated_at',
       'max_concurrent_renders', 'max_jobs_per_month', 'max_render_seconds_per_month',
       'max_stored_bytes', 'max_job_seconds', 'max_script_ops', 'artifact_retention_days'
     );
  if bad is not null then
    raise exception 'org_entitlements has column(s) that are not limits: %', bad;
  end if;

  -- extra_limits is the hole in every check above, and it is worth naming plainly. It is
  -- jsonb, so its contents are data and not schema, and the column allowlist passes it by
  -- name no matter what is inside. A key written by the billing service such as
  -- seat_price_cents would sit in the open database and satisfy the column check here,
  -- the DDL check in scripts/check-seam.sh and the assertion in seam_none.sql, all three.
  -- So the keys themselves are read out and held to the same word list as the columns.
  --
  -- The jsonpath is '$.**' rather than jsonb_object_keys so that the walk reaches every
  -- depth. A nested {"seats": {"price_cents": 1200}} is the same breach as a top level
  -- one, and a guard that only reads the first level would be an invitation to nest. The
  -- document itself is unioned in beside its descendants so that a top level key is
  -- covered by the plain reading of the query rather than by a property of '$.**' that a
  -- reader would have to go and look up.
  select string_agg(distinct format('%s in org %s', k, e.org_id::text), ', ') into bad
    from public.org_entitlements e
    cross join lateral (
      select e.extra_limits as v
      union all
      select jsonb_path_query(e.extra_limits, '$.**')
    ) d
    cross join lateral jsonb_object_keys(
      case when jsonb_typeof(d.v) = 'object' then d.v else '{}'::jsonb end) as k
   where k ~* money_word;
  if bad is not null then
    raise exception 'org_entitlements.extra_limits holds key(s) about money: %', bad;
  end if;

  -- 4. The read surface.
  if to_regclass('public.v_org_usage_month') is null then
    raise exception 'v_org_usage_month is missing; the billing read surface does not exist';
  end if;

  select string_agg(column_name, ', ') into bad
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'v_org_usage_month'
     and column_name not in (
       'org_id', 'period_month', 'jobs_submitted', 'jobs_completed', 'jobs_failed',
       'render_seconds', 'bytes_stored', 'bytes_egress', 'plan_code', 'updated_at'
     );
  if bad is not null then
    raise exception 'v_org_usage_month exposes more than quantities: %', bad;
  end if;

  raise notice 'seam: no billing surface in the applied schema';
end
$$;

-- 5. The claim the README makes, tested rather than asserted: with no billing service
-- anywhere near this database, a brand new org is unmetered. Rolled back, so running the
-- check leaves nothing behind and it can be pointed at any environment.
--
-- What is being tested is the database, not an environment variable. Nothing in this
-- repository reads BILLING_MODE; the unmetered result comes from create_org seeding a row
-- whose limit columns are all null and from app.effective_entitlements treating null as
-- unlimited. So this section proves what a deployment with no billing service gets, and
-- it would fail, correctly, against a database where something had written real limits.
begin;

insert into auth.users (id, email)
values ('5ea11111-0000-4000-8000-000000000001'::uuid, 'seam@verify.test');

do $$
declare
  e record;
  v_org uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"5ea11111-0000-4000-8000-000000000001","role":"authenticated"}', true);
  v_org := (public.create_org('Seam Check', 'seam-check-tmp')).id;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select * into e from app.effective_entitlements(v_org);

  assert e.plan_code = 'unmetered',
    'a fresh org should be unmetered with no billing service, got ' || e.plan_code;
  assert e.max_jobs_per_month is null,
    'an org with no billing service must have no monthly job limit';
  assert e.max_render_seconds_per_month is null,
    'an org with no billing service must have no monthly seconds limit';
  assert e.max_stored_bytes is null,
    'an org with no billing service must have no storage limit';

  -- The ceilings are the machine's limits and not a plan's, so they survive.
  assert e.max_job_seconds = 1800, 'the platform job ceiling should still apply';
  assert e.max_script_ops = 2000, 'the platform op ceiling should still apply';
  assert e.max_concurrent_renders = 8, 'the platform concurrency ceiling should still apply';

  raise notice 'seam: an org with no billing service is unmetered under the platform ceilings';
end
$$;

rollback;
SQL

python3 scripts/run-sql.py --quiet "$sql"

echo "verify-seam: ok, the applied schema has no billing surface"
