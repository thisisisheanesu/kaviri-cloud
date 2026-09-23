-- Submitting a take. This is an RPC rather than a plain insert because three things have
-- to happen in one transaction or not at all: the monthly limits have to be checked, the
-- idempotency key has to be resolved against any earlier submission, and the usage
-- ledger has to record that a job was accepted. Doing that from the edge would leave a
-- window in which a limit is checked against a count that changed before the insert.

create or replace function public.submit_job(
  p_org_id uuid,
  p_project_slug text,
  p_script jsonb,
  p_options jsonb default '{}'::jsonb,
  p_idempotency_key text default null,
  p_source jsonb default '{}'::jsonb
)
returns public.render_jobs
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_job public.render_jobs;
  v_project public.projects;
  v_ent record;
  v_usage record;
  v_ops integer;
  v_key uuid := app.claim_api_key_id();
  v_user uuid := app.current_user_id();
begin
  -- SECURITY DEFINER runs as the owner, which means RLS is not doing the fencing here.
  -- This line is the fence.
  if not app.is_org_member(p_org_id) then
    raise exception 'no such org' using errcode = 'P0002';
  end if;

  if jsonb_typeof(p_script) <> 'array' then
    raise exception 'script must be a JSON array of ops' using errcode = '22023';
  end if;

  v_ops := jsonb_array_length(p_script);
  if v_ops = 0 then
    raise exception 'script is empty' using errcode = '22023';
  end if;

  select * into v_ent from app.effective_entitlements(p_org_id);

  if v_ops > v_ent.max_script_ops then
    raise exception 'script has % ops, the limit is %', v_ops, v_ent.max_script_ops
      using errcode = '54000';
  end if;

  -- Counters rather than the ledger, because this read is on the submit path and a month
  -- of ledger rows for a busy org is not something to aggregate per request.
  select coalesce(c.jobs_submitted, 0) as jobs_submitted,
         coalesce(c.render_seconds, 0) as render_seconds,
         coalesce(c.bytes_stored, 0) as bytes_stored
    into v_usage
    from (select 1) one
    left join public.usage_counters c
      on c.org_id = p_org_id and c.period_month = app.month_of(now());

  if v_ent.max_jobs_per_month is not null and v_usage.jobs_submitted >= v_ent.max_jobs_per_month then
    raise exception 'monthly job limit of % reached', v_ent.max_jobs_per_month
      using errcode = '54000';
  end if;

  if v_ent.max_render_seconds_per_month is not null
     and v_usage.render_seconds >= v_ent.max_render_seconds_per_month then
    raise exception 'monthly render seconds limit of % reached', v_ent.max_render_seconds_per_month
      using errcode = '54000';
  end if;

  if v_ent.max_stored_bytes is not null and v_usage.bytes_stored >= v_ent.max_stored_bytes then
    raise exception 'storage limit of % bytes reached', v_ent.max_stored_bytes
      using errcode = '54000';
  end if;

  -- A project appears the first time something films it. Requiring it to be created in
  -- advance would mean a new repository's first workflow run fails on setup rather than
  -- producing a video.
  insert into public.projects (org_id, slug, name)
  values (p_org_id, lower(btrim(p_project_slug)), lower(btrim(p_project_slug)))
  on conflict (org_id, slug) do update set updated_at = now()
  returning * into v_project;

  -- Resolved before the insert so that a retried submission returns the original job
  -- rather than colliding on the unique index and surfacing as a 500.
  if p_idempotency_key is not null then
    select * into v_job
      from public.render_jobs
     where org_id = p_org_id
       and idempotency_key = p_idempotency_key;
    if found then
      return v_job;
    end if;
  end if;

  insert into public.render_jobs (
    org_id, project_id, script, script_sha256, options, idempotency_key, source,
    created_by_key, created_by_user
  )
  values (
    p_org_id,
    v_project.id,
    p_script,
    -- Over the canonical text of the script, so the same ops submitted with different
    -- whitespace are the same content address.
    extensions.digest(p_script::text, 'sha256'),
    -- The project's defaults sit underneath, so a job that names a preset wins and one
    -- that does not inherits.
    coalesce(v_project.default_options, '{}'::jsonb) || coalesce(p_options, '{}'::jsonb),
    p_idempotency_key,
    coalesce(p_source, '{}'::jsonb),
    v_key,
    v_user
  )
  returning * into v_job;

  perform app.record_usage(p_org_id, 'job_submitted', 1, v_job.id, v_key,
    jsonb_build_object('ops', v_ops));

  return v_job;
end
$$;

revoke all on function public.submit_job(uuid, text, jsonb, jsonb, text, jsonb) from public;
grant execute on function public.submit_job(uuid, text, jsonb, jsonb, text, jsonb) to authenticated, kaviri_api;
