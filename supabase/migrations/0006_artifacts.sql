-- What a finished take leaves behind. The MP4 always, and optionally the telemetry
-- sidecar and a poster frame.
--
-- Rows here describe objects in R2. They never carry a signed URL: a signed URL has an
-- expiry and belongs to one request, so storing one would hand out a credential with the
-- lifetime of a database row. The API mints one per GET instead.

create type public.artifact_kind as enum ('video', 'poster', 'telemetry', 'log');

create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.render_jobs (id) on delete cascade,
  -- Denormalised from the job so that every policy on this table is a single-table
  -- predicate. A join in a policy is a join on every row of every query.
  org_id uuid not null references public.orgs (id) on delete cascade,

  kind public.artifact_kind not null,

  -- Object key in the bucket, not a URL. The bucket itself is configuration, so moving
  -- buckets is a deploy rather than a migration.
  storage_key text not null unique check (length(storage_key) between 1 and 1024),
  content_type text not null default 'video/mp4',
  bytes bigint not null check (bytes >= 0),
  -- Checksum of the object, so a corrupted download can be told from a corrupted render.
  sha256 bytea check (sha256 is null or octet_length(sha256) = 32),

  -- Enough to show a card without opening the file.
  duration_seconds numeric(10, 3) check (duration_seconds is null or duration_seconds >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),

  created_at timestamptz not null default now(),
  -- Mirrors the job's retention. Kept here too because the sweep deletes objects, and it
  -- should be able to find them without reasoning about job state.
  expires_at timestamptz,
  deleted_at timestamptz,

  -- One of each kind per job. A retry that produces a second video replaces the first
  -- rather than accumulating, which is enforced in complete_job.
  unique (job_id, kind)
);

create index artifacts_org_idx on public.artifacts (org_id) where deleted_at is null;
create index artifacts_expiry_idx on public.artifacts (expires_at) where deleted_at is null;

alter table public.artifacts enable row level security;
alter table public.artifacts force row level security;

create policy artifacts_select_member on public.artifacts
  for select
  using ((select app.is_org_member(org_id)));

-- No insert, update or delete policy and no write grant. Artifacts come into existence
-- only through complete_job, which is the single place that has proof a worker actually
-- uploaded the object it is claiming.
grant select on public.artifacts to authenticated, kaviri_api;
