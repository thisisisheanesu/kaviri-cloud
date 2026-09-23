-- The queue. One row is one take: a kaviri script, the options it renders under, and
-- wherever it has got to.
--
-- The state machine is specified in docs/LIFECYCLE.md and enforced below by a trigger
-- rather than by convention, because the worker, the reaper, the cancel path and the
-- retention sweep all write this column and only one of them is ever under review at a
-- time.

create type public.render_job_state as enum (
  'queued',
  'leased',
  'running',
  'uploading',
  'done',
  'failed',
  'cancelled',
  'expired'
);

create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,

  state public.render_job_state not null default 'queued',

  -- The script exactly as submitted, one op per array element, validated at the edge
  -- against the recorder's op protocol. Kept verbatim so a take can be replayed byte for
  -- byte when a customer asks why the video changed.
  script jsonb not null check (jsonb_typeof(script) = 'array'),
  -- Content address of the script, for deduplication and for telling a customer that
  -- nothing about their demo actually changed between two runs.
  script_sha256 bytea not null check (octet_length(script_sha256) = 32),
  -- preset, background, scale, out_width, out_height. Validated at the edge; stored
  -- resolved, with the project defaults already merged in, so the worker needs no
  -- context beyond this row.
  options jsonb not null default '{}'::jsonb,

  -- A client-supplied key making submission safe to retry. A GitHub Action that times
  -- out on the response and retries must not film the same commit twice.
  idempotency_key text
    check (idempotency_key is null or length(idempotency_key) between 8 and 200),

  -- Where the job came from, for the dashboard: repository, ref, commit, run id. Free
  -- form because a caller that is not a GitHub Action still wants to say something.
  source jsonb not null default '{}'::jsonb,

  created_by_key uuid references public.api_keys (id) on delete set null,
  created_by_user uuid references auth.users (id) on delete set null,

  -- Higher runs first. Reserved for support: everything a customer submits is 0, so the
  -- queue is fair by default and a stuck tenant can still be unstuck by hand.
  priority smallint not null default 0,

  -- The queue ignores a job until this moment, which is what makes retry backoff a
  -- property of the row rather than a sleep inside a worker.
  visible_at timestamptz not null default now(),

  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),

  -- The lease. A worker proves it still holds the job by presenting this token on every
  -- subsequent call, so a worker that was reaped and then came back to life cannot
  -- overwrite the result of the worker that replaced it.
  lease_token uuid,
  lease_worker_id text check (lease_worker_id is null or length(lease_worker_id) between 1 and 200),
  lease_expires_at timestamptz,

  -- Cooperative cancellation. A queued job is cancelled outright; a job already on a box
  -- gets this flag, sees it on its next heartbeat and stops, because killing a render
  -- mid-encode leaves a part file in object storage that nothing owns.
  cancel_requested boolean not null default false,

  progress real not null default 0 check (progress between 0 and 1),
  progress_message text check (progress_message is null or length(progress_message) <= 500),

  -- Structured so the API can return a stable code alongside prose that may be reworded.
  -- {"code": "...", "message": "...", "op_index": 3, "detail": {...}}
  error jsonb,

  -- Wall clock seconds the fleet spent on the take, summed across attempts. This is the
  -- metered quantity, and it is written only by complete_job.
  render_seconds numeric(12, 3) not null default 0 check (render_seconds >= 0),

  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- When the artifact stops being downloadable and the job becomes 'expired'. Set by
  -- complete_job from the org's retention limit.
  expires_at timestamptz,

  -- A lease is either wholly present or wholly absent. Half a lease is the state in
  -- which two workers can both believe they hold the job.
  constraint render_jobs_lease_coherent check (
    (lease_token is null and lease_worker_id is null and lease_expires_at is null)
    or (lease_token is not null and lease_worker_id is not null and lease_expires_at is not null)
  ),
  -- Only the three in-flight states may hold a lease. This is what makes an orphaned
  -- lease on a finished job impossible rather than merely unlikely.
  constraint render_jobs_lease_state check (
    (state in ('leased', 'running', 'uploading')) = (lease_token is not null)
  ),
  constraint render_jobs_terminal_finished check (
    (state in ('done', 'failed', 'cancelled', 'expired')) = (finished_at is not null)
  )
);

-- Retrying a submission must find the first job rather than create a second. Partial,
-- because most jobs carry no idempotency key and those must not collide with each other.
create unique index render_jobs_idempotency_idx
  on public.render_jobs (org_id, idempotency_key)
  where idempotency_key is not null;

-- The queue read in lease_next_job, and the only index it is allowed to need. Partial on
-- 'queued' so it stays small no matter how much history the table accumulates.
create index render_jobs_queue_idx
  on public.render_jobs (priority desc, visible_at, queued_at)
  where state = 'queued';

-- The reaper's read: everything currently held by a worker, ordered by when its lease
-- lapses.
create index render_jobs_lease_idx
  on public.render_jobs (lease_expires_at)
  where state in ('leased', 'running', 'uploading');

-- The dashboard's read: one org's recent jobs, newest first.
create index render_jobs_org_recent_idx
  on public.render_jobs (org_id, created_at desc);

-- The concurrency check inside lease_next_job counts an org's in-flight jobs on every
-- lease, so it gets its own partial index rather than sharing the one above.
create index render_jobs_org_inflight_idx
  on public.render_jobs (org_id)
  where state in ('leased', 'running', 'uploading');

-- The retention sweep's read.
create index render_jobs_expiry_idx
  on public.render_jobs (expires_at)
  where state = 'done';

create trigger render_jobs_touch
  before update on public.render_jobs
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The state machine
-- ---------------------------------------------------------------------------

-- Every legal edge, and nothing else. Kept as a function rather than a table so that the
-- rule and the enforcement cannot drift apart across a migration, and so that reading
-- this file tells you the whole machine.
create or replace function app.is_legal_transition(
  p_from public.render_job_state,
  p_to public.render_job_state
)
returns boolean
language sql
immutable
as $$
  select (p_from, p_to) in (
    -- A worker takes the job off the queue.
    ('queued',    'leased'),
    -- The customer changed their mind before anything picked it up.
    ('queued',    'cancelled'),
    -- The worker has the browser open and the recorder running.
    ('leased',    'running'),
    -- The lease lapsed with attempts left, or the worker handed the job back.
    ('leased',    'queued'),
    ('leased',    'failed'),
    ('leased',    'cancelled'),
    -- Capture finished; ffmpeg has rendered and the MP4 is going to object storage.
    ('running',   'uploading'),
    ('running',   'queued'),
    ('running',   'failed'),
    ('running',   'cancelled'),
    -- The upload is the last thing that can fail, and it is retryable like the rest.
    ('uploading', 'done'),
    ('uploading', 'queued'),
    ('uploading', 'failed'),
    ('uploading', 'cancelled'),
    -- Retention elapsed. The only edge out of a state the customer already saw as final,
    -- and the reason 'done' is described as terminal for the customer rather than terminal.
    ('done',      'expired')
  )
$$;

create or replace function app.enforce_job_state_machine()
returns trigger
language plpgsql
as $$
begin
  if new.state = old.state then
    return new;
  end if;

  if not app.is_legal_transition(old.state, new.state) then
    raise exception 'illegal render_jobs transition % -> % for job %', old.state, new.state, old.id
      using errcode = '23514';
  end if;

  -- attempt only ever climbs. A worker that could reset it could retry forever.
  if new.attempt < old.attempt then
    raise exception 'render_jobs.attempt must not decrease (job %)', old.id
      using errcode = '23514';
  end if;

  -- Returning to the queue is a fresh start for the lease but not for the history, so
  -- the lease columns are cleared here rather than being every caller's responsibility.
  if new.state = 'queued' then
    new.lease_token := null;
    new.lease_worker_id := null;
    new.lease_expires_at := null;
    new.progress := 0;
    new.started_at := null;
  end if;

  if new.state in ('done', 'failed', 'cancelled', 'expired') then
    new.finished_at := coalesce(new.finished_at, now());
    new.lease_token := null;
    new.lease_worker_id := null;
    new.lease_expires_at := null;
  end if;

  if new.state = 'running' then
    new.started_at := coalesce(new.started_at, now());
  end if;

  return new;
end
$$;

create trigger render_jobs_state_machine
  before update of state on public.render_jobs
  for each row execute function app.enforce_job_state_machine();

-- A job is born queued. Anything else would mean a row existed in a state no transition
-- can produce, which is the same thing as the machine having a second, undocumented entry.
create or replace function app.enforce_job_birth_state()
returns trigger
language plpgsql
as $$
begin
  if new.state <> 'queued' then
    raise exception 'a render job must be inserted in the queued state, not %', new.state
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger render_jobs_birth_state
  before insert on public.render_jobs
  for each row execute function app.enforce_job_birth_state();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.render_jobs enable row level security;
alter table public.render_jobs force row level security;

create policy render_jobs_select_member on public.render_jobs
  for select
  using ((select app.is_org_member(org_id)));

create policy render_jobs_insert_member on public.render_jobs
  for insert
  with check ((select app.is_org_member(org_id)));

-- A customer may ask for a cancel and may not do anything else to a job. The state
-- column is not in the update grant below, so this policy governs the flag alone.
create policy render_jobs_update_member on public.render_jobs
  for update
  using ((select app.is_org_member(org_id)))
  with check ((select app.is_org_member(org_id)));

grant select on public.render_jobs to authenticated, kaviri_api;
grant insert on public.render_jobs to authenticated, kaviri_api;
-- Deliberately narrow. State is moved by the three worker functions and by the
-- maintenance functions, never by a client, so a customer cannot mark their own job done
-- and a leaked key cannot rewrite history.
grant update (cancel_requested) on public.render_jobs to authenticated, kaviri_api;
