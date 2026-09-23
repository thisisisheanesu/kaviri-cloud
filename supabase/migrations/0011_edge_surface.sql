-- Integration migration: the two things the edge and the fleet needed that the first ten
-- did not provide.
--
-- Both were found by checking the components against each other rather than in isolation,
-- which is why neither showed up while each piece was being written.

-- ---------------------------------------------------------------------------
-- 1. Two public wrappers, so the edge can reach the app schema without it being exposed
-- ---------------------------------------------------------------------------

-- The api Worker has to call app.verify_api_key and app.effective_entitlements on every
-- request, but 0001 deliberately keeps the app schema out of PostgREST's exposed list:
-- app is where the membership predicates live, and a PostgREST-reachable
-- app.is_org_member(uuid) would let any authenticated caller ask the database who is a
-- member of an org they have nothing to do with.
--
-- Exposing the schema would therefore trade a real boundary for convenience. Two named
-- wrappers in public cost nothing and keep the rest of app unreachable, so the edge sets
-- APP_RPC_SCHEMA=public and PostgREST's exposed schema list stays as it is.

create or replace function public.verify_api_key(p_presented text)
returns table (key_id uuid, org_id uuid)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select v.key_id, v.org_id from app.verify_api_key(p_presented) v;
$$;

comment on function public.verify_api_key(text) is
  'PostgREST-reachable wrapper over app.verify_api_key, so the edge can resolve a key '
  'without the app schema being exposed. Granted to kaviri_api only.';

-- Not granted to authenticated: a signed-in human has no business trading a presented
-- string for an org id, and only the edge resolver role ever needs this.
revoke all on function public.verify_api_key(text) from public;
grant execute on function public.verify_api_key(text) to kaviri_api, service_role;

create or replace function public.effective_entitlements(p_org_id uuid)
returns table (
  plan_code text,
  max_concurrent_renders integer,
  max_jobs_per_month integer,
  max_render_seconds_per_month integer,
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
  select e.plan_code,
         e.max_concurrent_renders,
         e.max_jobs_per_month,
         e.max_render_seconds_per_month,
         e.max_stored_bytes,
         e.max_job_seconds,
         e.max_script_ops,
         e.artifact_retention_days,
         e.extra_limits
    from app.effective_entitlements(p_org_id) e
   where app.is_org_member(p_org_id);
$$;

comment on function public.effective_entitlements(uuid) is
  'PostgREST-reachable wrapper over app.effective_entitlements. Unlike the function it '
  'wraps it is membership-checked, because it is reachable by a signed-in human and a '
  'plan limit is not something one org should be able to read about another.';

revoke all on function public.effective_entitlements(uuid) from public;
grant execute on function public.effective_entitlements(uuid) to authenticated, kaviri_api, service_role;

-- ---------------------------------------------------------------------------
-- 2. The lease tells the worker where to put the object
-- ---------------------------------------------------------------------------

-- The object key carries the retention class as its second segment, because an R2
-- lifecycle rule can filter on a prefix and on nothing else. The fleet therefore has to
-- know artifact_retention_days BEFORE it uploads, and the lease was the only round trip
-- it makes before then. Without this the worker has to guess, and a guess writes an
-- object under a prefix no lifecycle rule matches, which is a bucket that grows forever.
--
-- A returns-table change cannot be done with create or replace, so the function is
-- dropped and rebuilt. The body is unchanged apart from the one extra column.

drop function if exists public.lease_next_job(text, integer, jsonb);

create function public.lease_next_job(
  p_worker_id text,
  p_lease_seconds integer default null,
  p_capabilities jsonb default '{}'::jsonb
)
returns table (
  job_id uuid,
  org_id uuid,
  project_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt integer,
  max_attempts integer,
  script jsonb,
  options jsonb,
  max_job_seconds integer,
  artifact_retention_days integer
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_lease integer := least(greatest(coalesce(p_lease_seconds, app.default_lease_seconds()), 15), 900);
  v_token uuid := gen_random_uuid();
  v_job public.render_jobs;
  v_max_job_seconds integer;
  v_retention integer;
begin
  if p_worker_id is null or length(btrim(p_worker_id)) = 0 then
    raise exception 'lease_next_job requires a worker id' using errcode = '22023';
  end if;

  with candidate as (
    select j.id
      from public.render_jobs j
     where j.state = 'queued'
       and j.visible_at <= now()
       and not j.cancel_requested
       and (
         select count(*)
           from public.render_jobs inflight
          where inflight.org_id = j.org_id
            and inflight.state in ('leased', 'running', 'uploading')
       ) < (select ee.max_concurrent_renders from app.effective_entitlements(j.org_id) ee)
     order by j.priority desc, j.visible_at, j.queued_at
     for update skip locked
     limit 1
  )
  update public.render_jobs j
     set state = 'leased',
         attempt = j.attempt + 1,
         lease_token = v_token,
         lease_worker_id = btrim(p_worker_id),
         lease_expires_at = now() + make_interval(secs => v_lease),
         progress = 0,
         progress_message = null
    from candidate
   where j.id = candidate.id
  returning j.* into v_job;

  if not found then
    return;
  end if;

  job_id := v_job.id;
  org_id := v_job.org_id;
  project_id := v_job.project_id;
  lease_token := v_token;
  lease_expires_at := v_job.lease_expires_at;
  attempt := v_job.attempt;
  max_attempts := v_job.max_attempts;
  script := v_job.script;
  options := v_job.options;

  -- Read into locals first. Assigning straight into an OUT parameter of the same name as
  -- the source column is the ambiguity that bit this function once already.
  select ee.max_job_seconds, ee.artifact_retention_days
    into v_max_job_seconds, v_retention
    from app.effective_entitlements(v_job.org_id) ee;

  max_job_seconds := v_max_job_seconds;
  artifact_retention_days := v_retention;
  return next;
end
$$;

revoke all on function public.lease_next_job(text, integer, jsonb) from public;
grant execute on function public.lease_next_job(text, integer, jsonb) to kaviri_worker, service_role;
