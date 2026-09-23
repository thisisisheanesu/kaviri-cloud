-- Projects group takes that belong to the same product, and API keys are how a machine
-- caller such as a GitHub Action proves which org it speaks for.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- Unique within the org, not globally, because two customers filming two different
  -- products both reasonably call theirs "web".
  slug text not null
    check (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]?$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Defaults merged under a job's own options at submit time, so a repository can set
  -- the preset and the backdrop once instead of in every workflow file.
  default_options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (org_id, slug)
);

create trigger projects_touch
  before update on public.projects
  for each row execute function app.touch_updated_at();

alter table public.projects enable row level security;
alter table public.projects force row level security;

create policy projects_select_member on public.projects
  for select
  using ((select app.is_org_member(org_id)));

-- A machine caller may create a project implicitly by submitting to a new slug, which is
-- why insert is membership-gated rather than admin-gated, but it may not rename or
-- delete one.
create policy projects_insert_member on public.projects
  for insert
  with check ((select app.is_org_member(org_id)));

create policy projects_update_admin on public.projects
  for update
  using ((select app.is_org_admin(org_id)))
  with check ((select app.is_org_admin(org_id)));

create policy projects_delete_admin on public.projects
  for delete
  using ((select app.is_org_admin(org_id)));

grant select, insert on public.projects to authenticated, kaviri_api;
grant update, delete on public.projects to authenticated;

-- ---------------------------------------------------------------------------
-- API keys
-- ---------------------------------------------------------------------------

-- A presented key looks like kv_<prefix>_<secret>. The prefix identifies the row in a
-- list without revealing anything usable, and the secret is 256 bits of randomness.
--
-- Only the SHA-256 of the whole presented string is stored. There is no pepper and none
-- is needed: the secret is full-entropy random rather than a password, so there is
-- nothing to guess offline and nothing a rainbow table shortens. What matters instead is
-- that a database dump cannot be replayed as a key, and a hash gives that.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,

  -- The displayable half, kv_ plus eight lowercase base32 characters. Unique so that a
  -- support conversation about "key kv_7f3k4x2m" is never ambiguous.
  prefix text not null unique
    check (prefix ~ '^kv_[a-z2-7]{8}$'),

  -- SHA-256 of the full presented key, 32 bytes. Unique so that a repeated registration
  -- of the same secret is a conflict rather than two rows that both authenticate.
  key_hash bytea not null unique
    check (octet_length(key_hash) = 32),

  name text not null default 'unnamed' check (length(btrim(name)) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  -- Coarse on purpose. Updating it on every request would make key verification a write
  -- on the hot path; app.verify_api_key only advances it when it has gone stale.
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

create index api_keys_org_idx on public.api_keys (org_id) where revoked_at is null;

alter table public.api_keys enable row level security;
alter table public.api_keys force row level security;

-- Listing keys is an owner and admin action. A member cannot enumerate the credentials
-- of the org they are in, and a machine caller cannot enumerate its siblings.
create policy api_keys_select_admin on public.api_keys
  for select
  using ((select app.is_org_admin(org_id)));

-- Revocation is the one field a human changes directly. Issuing goes through
-- register_api_key, because the row has to be created from a hash the database never
-- saw the input of.
create policy api_keys_revoke_admin on public.api_keys
  for update
  using ((select app.is_org_admin(org_id)))
  with check ((select app.is_org_admin(org_id)));

-- Column-level grants, not just RLS. Even an admin reading their own org's keys must not
-- be able to select key_hash, because a leak of the hash column plus a leak of the
-- prefix is most of the way to an offline check of a guessed secret, and because there
-- is no legitimate client-side use for it.
grant select (id, org_id, prefix, name, created_by, created_at, last_used_at, expires_at, revoked_at)
  on public.api_keys to authenticated;
grant update (name, revoked_at) on public.api_keys to authenticated;

-- Registering a key. The edge Worker generates the secret with a CSPRNG, shows it to the
-- human exactly once, and sends only the prefix and the hash here. Generating it inside
-- the database instead would put the plaintext in a result set, a query log and possibly
-- a replication stream, for no benefit.
create or replace function public.register_api_key(
  p_org_id uuid,
  p_prefix text,
  p_key_hash bytea,
  p_name text default 'unnamed',
  p_expires_at timestamptz default null
)
returns public.api_keys
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_row public.api_keys;
begin
  if not app.is_org_admin(p_org_id) then
    raise exception 'not an admin of this org' using errcode = '42501';
  end if;

  insert into public.api_keys (org_id, prefix, key_hash, name, created_by, expires_at)
  values (p_org_id, p_prefix, p_key_hash, btrim(p_name), app.current_user_id(), p_expires_at)
  returning * into v_row;

  -- Blanked in the returned row so the hash cannot be read back out through the one
  -- path that necessarily writes it.
  v_row.key_hash := '\x'::bytea;
  return v_row;
end
$$;

revoke all on function public.register_api_key(uuid, text, bytea, text, timestamptz) from public;
grant execute on function public.register_api_key(uuid, text, bytea, text, timestamptz) to authenticated;

-- Verification, called by the edge with a role that has no org claim of its own. It
-- returns the org to scope the request to, or no rows. The caller then mints a
-- short-lived JWT carrying kaviri_org and does the actual work under it.
create or replace function app.verify_api_key(p_presented text)
returns table (key_id uuid, org_id uuid)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_prefix text;
  v_hash bytea;
  v_row record;
begin
  -- A malformed key is rejected on shape before it touches the index, so that garbage
  -- traffic costs a regex rather than a lookup.
  if p_presented !~ '^kv_[a-z2-7]{8}_[A-Za-z0-9_-]{16,128}$' then
    return;
  end if;

  v_prefix := substring(p_presented from 1 for 11);
  v_hash := extensions.digest(p_presented, 'sha256');

  select k.id, k.org_id, k.last_used_at
    into v_row
  from public.api_keys k
  join public.orgs o on o.id = k.org_id
  where k.prefix = v_prefix
    and k.key_hash = v_hash
    and k.revoked_at is null
    and (k.expires_at is null or k.expires_at > now())
    and o.deleted_at is null;

  if not found then
    return;
  end if;

  -- Written only when it has gone stale, because the value is for a human reading a key
  -- list and a per-request write would put a row lock on the busiest path in the system.
  if v_row.last_used_at is null or v_row.last_used_at < now() - interval '5 minutes' then
    update public.api_keys set last_used_at = now() where id = v_row.id;
  end if;

  key_id := v_row.id;
  org_id := v_row.org_id;
  return next;
end
$$;

revoke all on function app.verify_api_key(text) from public;
grant execute on function app.verify_api_key(text) to kaviri_api, service_role;
