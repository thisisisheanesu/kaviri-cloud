-- The render fleet's entire database surface: three functions, no table privileges, no
-- service role key.
--
-- The fleet connects with a JWT whose role claim is kaviri_worker. That role can execute
-- these three functions and can select nothing, insert nothing and update nothing. A box
-- that is compromised can therefore lease jobs and lie about their outcome, which is bad
-- but bounded, rather than read every tenant's scripts, which would be unbounded.
--
-- Within the three, authority is per job: lease_next_job mints a random lease_token and
-- returns it once, and the other two do nothing at all without it. A worker that was
-- reaped and then woke up still holding a stale token cannot overwrite the result
-- produced by the worker that replaced it, because the token no longer matches.

-- How long a lease lasts if the caller does not say. Long enough to survive a slow
-- Chromium start and a stalled heartbeat, short enough that a dead box does not hold a
-- customer's job for minutes.
create or replace function app.default_lease_seconds()
returns integer
language sql
immutable
as $$
  select 120
$$;

-- ---------------------------------------------------------------------------
-- 1. lease_next_job
-- ---------------------------------------------------------------------------

create or replace function public.lease_next_job(
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
  max_job_seconds integer
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
begin
  if p_worker_id is null or length(btrim(p_worker_id)) = 0 then
    raise exception 'lease_next_job requires a worker id' using errcode = '22023';
  end if;

  -- SKIP LOCKED is what makes two workers polling at the same instant take two different
  -- jobs instead of contending for one: the second reader steps over the row the first
  -- has locked rather than waiting behind it.
  --
  -- The correlated count is the per-org concurrency limit. It is applied here rather than
  -- at submit time because concurrency is a property of the moment, not of the queue, and
  -- because doing it here means an org at its limit leaves its jobs queued and visible
  -- instead of having them rejected.
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
  select ee.max_job_seconds into v_max_job_seconds from app.effective_entitlements(v_job.org_id) ee;
  max_job_seconds := v_max_job_seconds;
  return next;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. report_progress
-- ---------------------------------------------------------------------------

-- The heartbeat. It does three jobs at once on purpose: it extends the lease so the
-- reaper leaves the job alone, it moves the job through the in-flight states, and it
-- tells the worker whether the customer has asked for a cancel. One round trip, because
-- the worker is in the middle of a capture pump and every millisecond it spends here is
-- a millisecond of the filmed app running slower.
create or replace function public.report_progress(
  p_job_id uuid,
  p_lease_token uuid,
  p_progress real default null,
  p_message text default null,
  p_state public.render_job_state default null,
  p_lease_seconds integer default null
)
returns table (
  state public.render_job_state,
  cancel_requested boolean,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_lease integer := least(greatest(coalesce(p_lease_seconds, app.default_lease_seconds()), 15), 900);
  v_job public.render_jobs;
begin
  if p_state is not null and p_state not in ('running', 'uploading') then
    raise exception 'report_progress may only move a job to running or uploading, not %', p_state
      using errcode = '22023';
  end if;

  update public.render_jobs j
     set state = coalesce(p_state, j.state),
         progress = coalesce(greatest(least(p_progress, 1), 0), j.progress),
         progress_message = coalesce(left(p_message, 500), j.progress_message),
         lease_expires_at = now() + make_interval(secs => v_lease)
   where j.id = p_job_id
     -- The whole authorisation check. A wrong or stale token matches nothing, and the
     -- caller gets the same "not your job" as one that made the id up.
     and j.lease_token = p_lease_token
     and j.state in ('leased', 'running', 'uploading')
     -- An expired lease is refused rather than silently renewed, because the reaper may
     -- already have handed this job to somebody else and the loser has to find out.
     and j.lease_expires_at > now()
  returning j.* into v_job;

  if not found then
    raise exception 'no leased job % for this token', p_job_id using errcode = '42501';
  end if;

  state := v_job.state;
  cancel_requested := v_job.cancel_requested;
  lease_expires_at := v_job.lease_expires_at;
  return next;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. complete_job
-- ---------------------------------------------------------------------------

-- The only way an artifact row is ever created, and the only place render_seconds is
-- ever metered. Both happen in the same transaction as the state change, so there is no
-- window in which a customer can see a finished job with no video, or be billed for a
-- take whose result was rolled back.
--
-- p_artifacts is an array of objects the worker has ALREADY uploaded to object storage:
--   [{"kind":"video","storage_key":"orgs/…/take.mp4","bytes":8123456,
--     "content_type":"video/mp4","sha256":"<hex>","duration_seconds":21.4,
--     "width":1080,"height":1920}]
-- Upload first, then call this, because a row pointing at an object that does not exist
-- is a 404 on the customer's link, whereas an object with no row is a sweep's problem.
create or replace function public.complete_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_render_seconds numeric default 0,
  p_artifacts jsonb default '[]'::jsonb,
  p_error jsonb default null
)
returns table (
  state public.render_job_state,
  attempt integer,
  retry_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_job public.render_jobs;
  v_next public.render_job_state;
  v_retry_at timestamptz;
  v_retention integer;
  v_expires timestamptz;
  v_bytes bigint := 0;
  v_art jsonb;
  v_retryable boolean;
begin
  if p_outcome not in ('done', 'failed', 'cancelled') then
    raise exception 'complete_job outcome must be done, failed or cancelled, not %', p_outcome
      using errcode = '22023';
  end if;

  -- Locked for the whole of the rest of this function, so the reaper cannot requeue the
  -- job between the check and the write.
  select j.* into v_job
    from public.render_jobs j
   where j.id = p_job_id
     and j.lease_token = p_lease_token
     and j.state in ('leased', 'running', 'uploading')
   for update;

  if not found then
    raise exception 'no leased job % for this token', p_job_id using errcode = '42501';
  end if;

  if p_outcome = 'done' and not exists (
    select 1 from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb)) a
     where a ->> 'kind' = 'video'
  ) then
    raise exception 'a job cannot complete as done without a video artifact'
      using errcode = '22023';
  end if;

  select ee.artifact_retention_days into v_retention
    from app.effective_entitlements(v_job.org_id) ee;
  v_expires := now() + make_interval(days => v_retention);

  -- Artifacts land before the state moves, so that the instant a customer polling the
  -- status endpoint sees 'done' there is something behind the download link.
  for v_art in select * from jsonb_array_elements(coalesce(p_artifacts, '[]'::jsonb))
  loop
    insert into public.artifacts (
      job_id, org_id, kind, storage_key, content_type, bytes, sha256,
      duration_seconds, width, height, expires_at
    )
    values (
      v_job.id,
      v_job.org_id,
      (v_art ->> 'kind')::public.artifact_kind,
      v_art ->> 'storage_key',
      coalesce(v_art ->> 'content_type', 'application/octet-stream'),
      coalesce((v_art ->> 'bytes')::bigint, 0),
      case when v_art ? 'sha256' then decode(v_art ->> 'sha256', 'hex') else null end,
      (v_art ->> 'duration_seconds')::numeric,
      (v_art ->> 'width')::integer,
      (v_art ->> 'height')::integer,
      v_expires
    )
    -- A retry that re-renders the same take replaces the previous attempt's object
    -- rather than accumulating one per attempt, which would meter storage the customer
    -- cannot see or delete.
    on conflict (job_id, kind) do update
      set storage_key = excluded.storage_key,
          content_type = excluded.content_type,
          bytes = excluded.bytes,
          sha256 = excluded.sha256,
          duration_seconds = excluded.duration_seconds,
          width = excluded.width,
          height = excluded.height,
          expires_at = excluded.expires_at,
          deleted_at = null,
          created_at = now();

    v_bytes := v_bytes + coalesce((v_art ->> 'bytes')::bigint, 0);
  end loop;

  -- A retry is the default for a failure, because most of what goes wrong on a render box
  -- is transient: a browser that would not start, a spool that filled, a box that was
  -- reclaimed. A worker that knows better says so with {"retryable": false}, which is what
  -- a bad script or an unreachable URL should set, since filming it again changes nothing.
  v_retryable := coalesce((p_error ->> 'retryable')::boolean, true);

  if p_outcome = 'done' then
    v_next := 'done';
  elsif p_outcome = 'cancelled' then
    v_next := 'cancelled';
  elsif v_retryable and v_job.attempt < v_job.max_attempts then
    v_next := 'queued';
    -- Exponential, from the attempt just consumed: 15s, 60s, 240s. Long enough for a
    -- flaky box to be replaced, short enough that a CI job waiting on the video does not
    -- time out before the retry even starts.
    v_retry_at := now() + make_interval(secs => 15 * power(4, v_job.attempt - 1)::integer);
  else
    v_next := 'failed';
  end if;

  update public.render_jobs j
     set state = v_next,
         progress = case when v_next = 'done' then 1 else j.progress end,
         error = case when p_outcome = 'done' then null else p_error end,
         render_seconds = j.render_seconds + greatest(coalesce(p_render_seconds, 0), 0),
         visible_at = coalesce(v_retry_at, j.visible_at),
         expires_at = case when v_next = 'done' then v_expires else j.expires_at end,
         finished_at = case when v_next in ('done', 'failed', 'cancelled') then now() else null end
   where j.id = v_job.id;

  -- Metered even for a failed or cancelled take, because the fleet burned the seconds
  -- either way and pretending otherwise makes capacity planning a guess. A retry adds its
  -- own seconds on its own completion, which is why this is a ledger entry per attempt
  -- rather than a total written once.
  if coalesce(p_render_seconds, 0) > 0 then
    perform app.record_usage(
      v_job.org_id,
      'render_seconds',
      p_render_seconds,
      v_job.id,
      v_job.created_by_key,
      jsonb_build_object('attempt', v_job.attempt, 'outcome', p_outcome)
    );
  end if;

  if v_next = 'done' and v_bytes > 0 then
    perform app.record_usage(
      v_job.org_id, 'bytes_stored', v_bytes, v_job.id, v_job.created_by_key,
      jsonb_build_object('artifacts', jsonb_array_length(coalesce(p_artifacts, '[]'::jsonb)))
    );
  end if;

  if v_next in ('done', 'failed') then
    insert into public.usage_counters as c (org_id, period_month)
    values (v_job.org_id, app.month_of(now()))
    on conflict (org_id, period_month) do nothing;

    update public.usage_counters c
       set jobs_completed = c.jobs_completed + (case when v_next = 'done' then 1 else 0 end),
           jobs_failed = c.jobs_failed + (case when v_next = 'failed' then 1 else 0 end),
           updated_at = now()
     where c.org_id = v_job.org_id
       and c.period_month = app.month_of(now());
  end if;

  state := v_next;
  attempt := v_job.attempt;
  retry_at := v_retry_at;
  return next;
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Revoked from public first, because execute on a new function is granted to public by
-- default and every grant below would otherwise be decoration.
revoke all on function public.lease_next_job(text, integer, jsonb) from public;
revoke all on function public.report_progress(uuid, uuid, real, text, public.render_job_state, integer) from public;
revoke all on function public.complete_job(uuid, uuid, text, numeric, jsonb, jsonb) from public;

grant execute on function public.lease_next_job(text, integer, jsonb) to kaviri_worker, service_role;
grant execute on function public.report_progress(uuid, uuid, real, text, public.render_job_state, integer) to kaviri_worker, service_role;
grant execute on function public.complete_job(uuid, uuid, text, numeric, jsonb, jsonb) to kaviri_worker, service_role;
