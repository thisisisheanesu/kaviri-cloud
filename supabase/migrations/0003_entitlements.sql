-- THE SEAM.
--
-- This table is the entire write surface the private billing service has on this
-- database. It holds what a tenant is ALLOWED TO DO. It does not hold, and must never
-- hold, what a tenant PAYS: no amount, no currency, no interval, no Stripe identifier,
-- no discount, no invoice, no trial end date that only means something next to a price.
--
-- The rule that keeps the seam honest: if removing the billing service entirely would
-- make a column meaningless, the column is in the wrong repository. Limits survive that
-- removal, because a deployment with no billing at all still needs to know how much
-- concurrency to give a tenant. Prices do not.
--
-- A null limit means unlimited. That is deliberate: it makes the unmetered default the
-- absence of a constraint rather than a very large number that some comparison will one
-- day overflow or forget to special-case.

create table public.org_entitlements (
  org_id uuid primary key references public.orgs (id) on delete cascade,

  -- An opaque label the open service only ever displays and groups by. It carries no
  -- entitlement of its own: everything the platform enforces is a numeric limit below,
  -- so a mislabelled plan cannot grant capability it did not also set a limit for.
  plan_code text not null default 'unmetered'
    check (plan_code ~ '^[a-z0-9][a-z0-9_-]{0,38}$'),

  -- How many of this org's jobs may be leased at once. The queue enforces it in
  -- lease_next_job, so an org that submits a thousand jobs waits rather than starving
  -- the fleet of every other tenant.
  max_concurrent_renders integer
    check (max_concurrent_renders is null or max_concurrent_renders > 0),

  -- Per calendar month, UTC. Checked at submit time against v_org_usage_month.
  max_jobs_per_month integer
    check (max_jobs_per_month is null or max_jobs_per_month >= 0),
  max_render_seconds_per_month bigint
    check (max_render_seconds_per_month is null or max_render_seconds_per_month >= 0),
  max_stored_bytes bigint
    check (max_stored_bytes is null or max_stored_bytes >= 0),

  -- Per job. A wall clock ceiling is the only thing standing between one pathological
  -- script and a render box held forever, so a null here still gets the platform ceiling
  -- applied on top; see app.effective_entitlements.
  max_job_seconds integer
    check (max_job_seconds is null or max_job_seconds > 0),
  max_script_ops integer
    check (max_script_ops is null or max_script_ops > 0),

  -- How long a finished MP4 stays downloadable before the sweep expires it.
  artifact_retention_days integer
    check (artifact_retention_days is null or artifact_retention_days > 0),

  -- Room for a limit that does not yet have a column, so that shipping one does not
  -- require a migration in this repository timed against a deploy of the private one.
  -- Values here are limits under the same rule as the columns above.
  extra_limits jsonb not null default '{}'::jsonb,

  -- Written by whatever set this row, for support. 'default' is what an org is seeded
  -- with; the billing service stamps its own name when it takes over a row.
  source text not null default 'default'
    check (source ~ '^[a-z0-9][a-z0-9_.-]{0,38}$'),
  updated_at timestamptz not null default now()
);

comment on table public.org_entitlements is
  'Plan LIMITS only. Prices, invoices and payment state live in the private billing repository and never in this database.';

create trigger org_entitlements_touch
  before update on public.org_entitlements
  for each row execute function app.touch_updated_at();

alter table public.org_entitlements enable row level security;
alter table public.org_entitlements force row level security;

-- A customer may read their own limits, because the dashboard shows them and an API
-- caller needs to know why it was refused. Nobody writes this table through PostgREST:
-- the seed comes from create_org, and any later change comes from the billing service
-- connecting with its own credential.
create policy org_entitlements_select_member on public.org_entitlements
  for select
  using ((select app.is_org_member(org_id)));

grant select on public.org_entitlements to authenticated, kaviri_api;

-- Platform ceilings. These are not a plan and not a price; they are the limits of the
-- machine, applied even to an unmetered tenant, so that BILLING_MODE=none is generous
-- rather than unbounded. A take that spools at roughly 15 to 25 MB per second cannot be
-- allowed to run for an hour on a shared box.
create or replace function app.platform_ceilings()
returns table (max_job_seconds integer, max_script_ops integer, max_concurrent_renders integer)
language sql
immutable
as $$
  select 1800, 2000, 8
$$;

-- What the queue and the submit path actually enforce: the tenant's limits, with the
-- platform ceiling applied on top, and unlimited where nothing says otherwise. Reading
-- entitlements anywhere else in the codebase is a bug, because it would miss the ceiling.
create or replace function app.effective_entitlements(p_org_id uuid)
returns table (
  plan_code text,
  max_concurrent_renders integer,
  max_jobs_per_month integer,
  max_render_seconds_per_month bigint,
  max_stored_bytes bigint,
  max_job_seconds integer,
  max_script_ops integer,
  artifact_retention_days integer,
  extra_limits jsonb
)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    coalesce(e.plan_code, 'unmetered'),
    least(coalesce(e.max_concurrent_renders, c.max_concurrent_renders), c.max_concurrent_renders),
    e.max_jobs_per_month,
    e.max_render_seconds_per_month,
    e.max_stored_bytes,
    least(coalesce(e.max_job_seconds, c.max_job_seconds), c.max_job_seconds),
    least(coalesce(e.max_script_ops, c.max_script_ops), c.max_script_ops),
    coalesce(e.artifact_retention_days, 30),
    coalesce(e.extra_limits, '{}'::jsonb)
  from app.platform_ceilings() c
  left join public.org_entitlements e on e.org_id = p_org_id
$$;

grant execute on function app.effective_entitlements(uuid) to authenticated, kaviri_api, kaviri_worker, service_role;
grant execute on function app.platform_ceilings() to authenticated, kaviri_api, kaviri_worker, service_role;
