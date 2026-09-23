-- What keeps the queue honest when a worker stops answering, and what reclaims storage
-- when a take has outlived its retention.
--
-- Both run on a schedule (see the pg_cron block at the bottom, and docs/LIFECYCLE.md).
-- Both are idempotent, so a missed run costs lateness and never correctness, and a
-- double run does nothing the single run did not.

-- ---------------------------------------------------------------------------
-- The reaper
-- ---------------------------------------------------------------------------

-- A render box can die in ways it cannot report: the process is killed, the machine is
-- reclaimed, the network partitions mid-take. The lease is the answer. A worker holds a
-- job only for as long as it keeps saying so, and when it stops the job comes back.
--
-- This is why report_progress refuses an expired lease. The reaper may already have
-- given the job to somebody else, and a worker that comes back from a long stall has to
-- discover that it lost rather than write a result over the winner's.
create or replace function public.reap_expired_leases(p_limit integer default 200)
returns table (job_id uuid, previous_state public.render_job_state, new_state public.render_job_state)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_job record;
  v_next public.render_job_state;
  v_backoff timestamptz;
begin
  for v_job in
    select id, state, attempt, max_attempts, org_id, created_by_key, lease_worker_id
      from public.render_jobs
     where state in ('leased', 'running', 'uploading')
       and lease_expires_at < now()
     order by lease_expires_at
     limit greatest(coalesce(p_limit, 200), 1)
     -- SKIP LOCKED again, so a reaper run overlapping a worker's complete_job leaves that
     -- job alone rather than blocking behind it and then undoing it.
     for update skip locked
  loop
    if v_job.attempt < v_job.max_attempts then
      v_next := 'queued';
      -- Shorter than complete_job's backoff, because a lapsed lease usually means the box
      -- is gone rather than that the work is wrong, and the job should land on a healthy
      -- box quickly.
      v_backoff := now() + make_interval(secs => 10 * v_job.attempt);
    else
      v_next := 'failed';
      v_backoff := null;
    end if;

    update public.render_jobs j
       set state = v_next,
           visible_at = coalesce(v_backoff, j.visible_at),
           error = case
                     when v_next = 'failed' then jsonb_build_object(
                       'code', 'lease_expired',
                       'message', 'the render worker stopped reporting and the job ran out of attempts',
                       'retryable', false,
                       'worker_id', j.lease_worker_id,
                       'attempts', j.attempt
                     )
                     else j.error
                   end,
           finished_at = case when v_next = 'failed' then now() else null end
     where j.id = v_job.id;

    job_id := v_job.id;
    previous_state := v_job.state;
    new_state := v_next;
    return next;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Cancellation, the half the customer cannot do alone
-- ---------------------------------------------------------------------------

-- A queued job is cancelled outright. A job already on a box is only flagged, because
-- killing a render mid-encode strands a multipart upload in the bucket that no row
-- points at. The worker sees the flag on its next heartbeat and completes as cancelled,
-- which is a clean stop with the temporary files removed.
create or replace function public.request_cancel(p_job_id uuid)
returns public.render_job_state
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_job public.render_jobs;
begin
  select * into v_job from public.render_jobs where id = p_job_id for update;

  if not found or not app.is_org_member(v_job.org_id) then
    -- Same answer for "no such job" and "not yours", so the endpoint cannot be used to
    -- probe whether an id exists in another tenant.
    raise exception 'no such job' using errcode = 'P0002';
  end if;

  if v_job.state in ('done', 'failed', 'cancelled', 'expired') then
    return v_job.state;
  end if;

  update public.render_jobs
     set cancel_requested = true,
         state = case when state = 'queued' then 'cancelled'::public.render_job_state else state end,
         finished_at = case when state = 'queued' then now() else finished_at end
   where id = v_job.id
  returning * into v_job;

  return v_job.state;
end
$$;

revoke all on function public.request_cancel(uuid) from public;
grant execute on function public.request_cancel(uuid) to authenticated, kaviri_api;

-- ---------------------------------------------------------------------------
-- Retention
-- ---------------------------------------------------------------------------

-- Marks what has outlived its retention. It does not delete objects from R2: a database
-- transaction cannot roll back an S3 delete, so the row is marked first and a separate
-- sweeper deletes what is marked. The worst case is an object that outlives its row by a
-- sweep interval, which costs storage. The reverse, a live row pointing at a deleted
-- object, costs a customer a broken link.
create or replace function public.expire_due_artifacts(p_limit integer default 500)
returns table (job_id uuid, artifact_id uuid, storage_key text)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  return query
  with due as (
    select a.id, a.job_id, a.storage_key, a.org_id, a.bytes
      from public.artifacts a
     where a.deleted_at is null
       and a.expires_at is not null
       and a.expires_at < now()
     order by a.expires_at
     limit greatest(coalesce(p_limit, 500), 1)
     for update skip locked
  ),
  marked as (
    update public.artifacts a
       set deleted_at = now()
      from due
     where a.id = due.id
    returning a.id, a.job_id, a.storage_key
  ),
  -- A job goes to 'expired' only once every artifact it owns is gone, so a take whose
  -- telemetry sidecar expired first does not report itself as expired while the video is
  -- still downloadable.
  finished as (
    update public.render_jobs j
       set state = 'expired'
     where j.state = 'done'
       -- Aliased rather than bare. This function returns OUT parameters called job_id and
       -- storage_key, and inside the body an unqualified column of the same name resolves
       -- to the parameter instead, which Postgres reports as an ambiguous reference at run
       -- time rather than at creation time.
       and j.id in (select m_job.job_id from marked m_job)
       and not exists (
         select 1 from public.artifacts a2
          where a2.job_id = j.id
            and a2.deleted_at is null
            and a2.id not in (select m_keep.id from marked m_keep)
       )
    returning j.id
  )
  select m.job_id, m.id, m.storage_key from marked m;
end
$$;

revoke all on function public.reap_expired_leases(integer) from public;
revoke all on function public.expire_due_artifacts(integer) from public;
grant execute on function public.reap_expired_leases(integer) to service_role;
grant execute on function public.expire_due_artifacts(integer) to service_role;

-- Scheduled in the database rather than from a Worker cron, so that a queue with a dead
-- lease recovers even when the edge deploy is broken. Wrapped in a guard because a plain
-- Postgres without pg_cron must still be able to apply this migration, and because the
-- self-hosted path runs these from a systemd timer instead.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';
    perform cron.schedule('kaviri-reap-leases', '* * * * *', 'select public.reap_expired_leases(200)');
    perform cron.schedule('kaviri-expire-artifacts', '17 * * * *', 'select public.expire_due_artifacts(500)');
  else
    raise notice 'pg_cron is not available here; run reap_expired_leases and expire_due_artifacts from an external scheduler.';
  end if;
exception
  when insufficient_privilege then
    raise notice 'not permitted to schedule pg_cron jobs; schedule reap_expired_leases and expire_due_artifacts externally.';
end
$$;
