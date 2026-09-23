-- Foundation: the private helper schema, the two non-human database roles, and the
-- predicates every Row Level Security policy in later migrations is written against.
--
-- Everything tenant-scoped in this database answers one question: does the current
-- request speak for this org? That question is answered in exactly one place, here, so
-- that a future table cannot invent its own weaker version of it.

create extension if not exists pgcrypto with schema extensions;

-- The helper schema is deliberately not added to PostgREST's exposed schemas. Nothing in
-- it is reachable over HTTP, which is what lets these functions be SECURITY DEFINER
-- without also being an API.
create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to authenticated, anon, service_role;

-- Two roles beyond Supabase's own. PostgREST switches into the role named by the JWT's
-- "role" claim, so a role here is how a caller class is told apart at the database level
-- rather than in application code that can forget.
--
--   kaviri_api    the edge Workers, acting for a machine caller that presented an API key.
--                 Scoped to one org by the kaviri_org claim in its short-lived JWT.
--   kaviri_worker the render fleet. It can see the queue functions and nothing else, and
--                 within those it can only touch a job whose lease token it holds.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'kaviri_api') then
    create role kaviri_api nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'kaviri_worker') then
    create role kaviri_worker nologin noinherit;
  end if;
end
$$;

-- authenticator is the role PostgREST connects as before it switches; without these
-- grants the switch fails and every request from these callers is a 500.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'grant kaviri_api to authenticator';
    execute 'grant kaviri_worker to authenticator';
  end if;
end
$$;

grant usage on schema app to kaviri_api, kaviri_worker;
grant usage on schema public to kaviri_api, kaviri_worker;
grant usage on schema extensions to kaviri_api, kaviri_worker;

-- Default privileges in public are wide open on a stock Postgres, which would hand the
-- worker role read access to every table added later. The queue functions are SECURITY
-- DEFINER precisely so that the role holding them needs no table privileges at all.
alter default privileges in schema public revoke all on tables from public;

-- ---------------------------------------------------------------------------
-- Who is asking
-- ---------------------------------------------------------------------------

-- The org an API-key request speaks for, or null for a human session. The edge Worker
-- resolves the presented key to an org itself and mints a short-lived JWT carrying this
-- claim, so the key never travels past the edge and the fleet never sees a service role
-- key that would dissolve every policy below.
create or replace function app.claim_org_id()
returns uuid
language sql
stable
as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'kaviri_org',
    ''
  ), '')::uuid
$$;

-- The API key row id behind an API-key request, used to attribute usage to the key that
-- caused it and to show a customer which key a runaway job came from.
create or replace function app.claim_api_key_id()
returns uuid
language sql
stable
as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'kaviri_key',
    ''
  ), '')::uuid
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  ), '')::uuid
$$;

-- The one membership predicate. It is SECURITY DEFINER because org_members is itself
-- RLS-protected and a policy that queried it directly would recurse forever.
--
-- A human is a member when a row says so. A machine is a member of exactly the one org
-- its key was issued for, and of no other, which is why the claim is compared rather
-- than trusted as a list.
create or replace function app.is_org_member(p_org_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user uuid := app.current_user_id();
  v_claim uuid := app.claim_org_id();
begin
  if p_org_id is null then
    return false;
  end if;

  if v_claim is not null then
    return v_claim = p_org_id;
  end if;

  if v_user is null then
    return false;
  end if;

  return exists (
    select 1
    from public.org_members m
    where m.org_id = p_org_id
      and m.user_id = v_user
  );
end
$$;

-- Administrative actions (inviting members, issuing keys, deleting a project) need more
-- than membership. A machine caller never qualifies: an API key is for submitting work,
-- so a leaked key cannot mint more keys or add a member.
create or replace function app.is_org_admin(p_org_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_user uuid := app.current_user_id();
begin
  if p_org_id is null or v_user is null or app.claim_org_id() is not null then
    return false;
  end if;

  return exists (
    select 1
    from public.org_members m
    where m.org_id = p_org_id
      and m.user_id = v_user
      and m.role in ('owner', 'admin')
  );
end
$$;

revoke all on function app.is_org_member(uuid) from public;
revoke all on function app.is_org_admin(uuid) from public;
grant execute on function app.is_org_member(uuid) to authenticated, kaviri_api, service_role;
grant execute on function app.is_org_admin(uuid) to authenticated, service_role;
grant execute on function app.claim_org_id() to authenticated, kaviri_api, kaviri_worker, service_role;
grant execute on function app.claim_api_key_id() to authenticated, kaviri_api, kaviri_worker, service_role;
grant execute on function app.current_user_id() to authenticated, kaviri_api, service_role;

-- ---------------------------------------------------------------------------
-- Shared conveniences
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Usage is reported and billed by calendar month in UTC. Deriving it in one function
-- keeps the ledger, the counters and the view from disagreeing about where a month ends
-- for a customer who submits a job at 23:59 on the last of the month.
create or replace function app.month_of(p_at timestamptz)
returns date
language sql
immutable
as $$
  select date_trunc('month', p_at at time zone 'utc')::date
$$;

grant execute on function app.month_of(timestamptz) to authenticated, anon, kaviri_api, kaviri_worker, service_role;
