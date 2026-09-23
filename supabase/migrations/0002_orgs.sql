-- Orgs and membership. An org is the unit of ownership, of isolation and of billing
-- limits. Every other tenant table carries org_id and is fenced by it.

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  -- The slug appears in URLs and in the dashboard, so it is reserved across all tenants
  -- rather than being unique per anything.
  slug text not null unique
    check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Soft delete, because a deleted org's render jobs and artifacts still have to be
  -- swept and accounted for after the customer is gone.
  deleted_at timestamptz
);

create trigger orgs_touch
  before update on public.orgs
  for each row execute function app.touch_updated_at();

create type public.org_role as enum ('owner', 'admin', 'member');

create table public.org_members (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

-- Listing an org's members is a per-org query, and resolving "which orgs am I in" is a
-- per-user query. The primary key serves the first; this index serves the second, which
-- app.is_org_member runs on effectively every request.
create index org_members_user_idx on public.org_members (user_id);

alter table public.orgs enable row level security;
alter table public.org_members enable row level security;
alter table public.orgs force row level security;
alter table public.org_members force row level security;

-- A select policy is also what bounds count(*), so a non-member's count of another org's
-- rows is zero rather than forbidden. That is the intended answer: the existence of
-- another tenant's data is itself not disclosed.
create policy orgs_select_member on public.orgs
  for select
  using ((select app.is_org_member(id)));

create policy orgs_update_admin on public.orgs
  for update
  using ((select app.is_org_admin(id)))
  with check ((select app.is_org_admin(id)));

-- Creating an org and deleting one both run through server-side functions rather than
-- direct table access, because each has to do more than write this one row: a create
-- also seeds the owner membership and the unmetered entitlement, and a delete has to
-- leave the sweep enough state to reclaim storage.
create policy org_members_select_member on public.org_members
  for select
  using ((select app.is_org_member(org_id)));

create policy org_members_write_admin on public.org_members
  for all
  using ((select app.is_org_admin(org_id)))
  with check ((select app.is_org_admin(org_id)));

grant select on public.orgs to authenticated, kaviri_api;
grant update (name) on public.orgs to authenticated;
grant select on public.org_members to authenticated, kaviri_api;
grant insert, update, delete on public.org_members to authenticated;

-- Creating an org is the one bootstrap that cannot be authorised by membership, because
-- the caller is not yet a member of anything. It is SECURITY DEFINER and takes the owner
-- from the verified JWT rather than from an argument, so a caller cannot create an org
-- owned by somebody else.
create or replace function public.create_org(p_name text, p_slug text)
returns public.orgs
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user uuid := app.current_user_id();
  v_org public.orgs;
begin
  if v_user is null then
    raise exception 'create_org requires an authenticated user'
      using errcode = '42501';
  end if;
  -- A machine caller must not be able to widen its own blast radius from one org to two.
  if app.claim_org_id() is not null then
    raise exception 'an API key cannot create an org'
      using errcode = '42501';
  end if;

  insert into public.orgs (name, slug)
  values (btrim(p_name), lower(btrim(p_slug)))
  returning * into v_org;

  insert into public.org_members (org_id, user_id, role)
  values (v_org.id, v_user, 'owner');

  -- Seeded here rather than by the billing service, so that a deployment with no billing
  -- service at all still has a complete, working org.
  insert into public.org_entitlements (org_id)
  values (v_org.id);

  return v_org;
end
$$;

revoke all on function public.create_org(text, text) from public;
grant execute on function public.create_org(text, text) to authenticated;
