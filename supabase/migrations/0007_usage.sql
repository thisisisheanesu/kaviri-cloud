-- Usage, in two shapes for two readers.
--
-- usage_events is the append-only ledger: one row per thing that happened, never
-- updated, so a disputed invoice can be reconstructed from it line by line.
-- usage_counters is the rolled-up month, so that enforcing a limit on the submit path is
-- one indexed read rather than an aggregate over the ledger.
--
-- v_org_usage_month, at the bottom, is the ONLY thing the private billing service reads.

create type public.usage_kind as enum (
  'job_submitted',
  'render_seconds',
  'bytes_stored',
  'bytes_egress'
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  job_id uuid references public.render_jobs (id) on delete set null,
  api_key_id uuid references public.api_keys (id) on delete set null,

  kind public.usage_kind not null,
  -- Numeric rather than bigint because render_seconds is fractional and a ledger that
  -- rounds each line does not add up to the month.
  quantity numeric(20, 3) not null check (quantity >= 0),

  occurred_at timestamptz not null default now(),
  -- Denormalised so the rollup and the view group on a stored value rather than
  -- recomputing a timezone-sensitive expression per row.
  period_month date not null default app.month_of(now()),

  detail jsonb not null default '{}'::jsonb
);

create index usage_events_org_month_idx on public.usage_events (org_id, period_month, kind);
create index usage_events_job_idx on public.usage_events (job_id);

-- The ledger is append only. Enforced rather than agreed, because the value of a ledger
-- is exactly that nobody can quietly adjust last month.
create or replace function app.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end
$$;

create trigger usage_events_append_only
  before update or delete on public.usage_events
  for each row execute function app.forbid_mutation();

create table public.usage_counters (
  org_id uuid not null references public.orgs (id) on delete cascade,
  period_month date not null,

  jobs_submitted bigint not null default 0 check (jobs_submitted >= 0),
  jobs_completed bigint not null default 0 check (jobs_completed >= 0),
  jobs_failed bigint not null default 0 check (jobs_failed >= 0),
  render_seconds numeric(20, 3) not null default 0 check (render_seconds >= 0),
  bytes_stored bigint not null default 0 check (bytes_stored >= 0),
  bytes_egress bigint not null default 0 check (bytes_egress >= 0),

  updated_at timestamptz not null default now(),
  primary key (org_id, period_month)
);

alter table public.usage_events enable row level security;
alter table public.usage_counters enable row level security;
alter table public.usage_events force row level security;
alter table public.usage_counters force row level security;

create policy usage_events_select_member on public.usage_events
  for select
  using ((select app.is_org_member(org_id)));

create policy usage_counters_select_member on public.usage_counters
  for select
  using ((select app.is_org_member(org_id)));

-- Read only for everybody who is not a SECURITY DEFINER function. Both tables are
-- written by app.record_usage alone.
grant select on public.usage_events to authenticated, kaviri_api;
grant select on public.usage_counters to authenticated, kaviri_api;

-- One writer for both tables, so the ledger and the rollup cannot disagree: either both
-- rows move or the transaction does not commit.
create or replace function app.record_usage(
  p_org_id uuid,
  p_kind public.usage_kind,
  p_quantity numeric,
  p_job_id uuid default null,
  p_api_key_id uuid default null,
  p_detail jsonb default '{}'::jsonb,
  p_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_month date := app.month_of(p_at);
begin
  if p_quantity is null or p_quantity < 0 then
    raise exception 'usage quantity must be non-negative, got %', p_quantity
      using errcode = '22023';
  end if;

  insert into public.usage_events (org_id, job_id, api_key_id, kind, quantity, occurred_at, period_month, detail)
  values (p_org_id, p_job_id, p_api_key_id, p_kind, p_quantity, p_at, v_month, coalesce(p_detail, '{}'::jsonb));

  insert into public.usage_counters as c (org_id, period_month)
  values (p_org_id, v_month)
  on conflict (org_id, period_month) do nothing;

  update public.usage_counters c
     set jobs_submitted = c.jobs_submitted + (case when p_kind = 'job_submitted' then 1 else 0 end),
         render_seconds = c.render_seconds + (case when p_kind = 'render_seconds' then p_quantity else 0 end),
         bytes_stored   = c.bytes_stored   + (case when p_kind = 'bytes_stored'   then p_quantity::bigint else 0 end),
         bytes_egress   = c.bytes_egress   + (case when p_kind = 'bytes_egress'   then p_quantity::bigint else 0 end),
         updated_at = now()
   where c.org_id = p_org_id
     and c.period_month = v_month;
end
$$;

revoke all on function app.record_usage(uuid, public.usage_kind, numeric, uuid, uuid, jsonb, timestamptz) from public;
grant execute on function app.record_usage(uuid, public.usage_kind, numeric, uuid, uuid, jsonb, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- THE SEAM, READ SIDE
-- ---------------------------------------------------------------------------

-- The one view the private billing service reads. It is a quantity report and nothing
-- else: no money, no rate, no plan pricing, and no customer identity beyond the org id
-- the billing service already holds.
--
-- Keeping it a view rather than letting billing read the tables means the shape it
-- depends on is declared here, in the open, and cannot be widened by accident.
create view public.v_org_usage_month
with (security_invoker = true)
as
select
  c.org_id,
  c.period_month,
  c.jobs_submitted,
  c.jobs_completed,
  c.jobs_failed,
  c.render_seconds,
  c.bytes_stored,
  c.bytes_egress,
  e.plan_code,
  c.updated_at
from public.usage_counters c
left join public.org_entitlements e on e.org_id = c.org_id;

comment on view public.v_org_usage_month is
  'The only usage surface the private billing repository reads. Quantities and a plan label, never money.';

grant select on public.v_org_usage_month to authenticated, kaviri_api, service_role;
