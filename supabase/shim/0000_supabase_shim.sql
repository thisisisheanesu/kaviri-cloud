-- Enough of Supabase to apply the migrations to a plain Postgres.
--
-- This file is NOT a migration and must never be applied to a Supabase project, which
-- already has all of it. It exists so that CI can prove, on a clean checkout with no
-- access to the private billing repository and no Supabase account, that the open
-- migrations apply and the service works end to end with BILLING_MODE=none.
--
-- A claim that the open repo stands alone rots within a month unless something runs.

create schema if not exists extensions;
create schema if not exists auth;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'shim-only-not-a-secret';
  end if;
end
$$;

grant usage on schema extensions to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant anon, authenticated, service_role to authenticator;

-- Supabase's auth.users, reduced to the columns the foreign keys in these migrations
-- actually reference.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique
);
