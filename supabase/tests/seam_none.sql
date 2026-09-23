-- The proof that the open repository stands alone.
--
-- Applied to a clean Postgres with the shim and every migration and nothing else: no
-- billing schema, no private repository, no entitlement row written by anybody but
-- create_org. If this passes, a deployment with no billing service is a working
-- deployment rather than a claim in a README.
--
-- Note what is and is not being proved. Nothing in this repository reads BILLING_MODE, so
-- the unmetered result below is not produced by a setting: it is produced by create_org
-- seeding a row whose limit columns are all null, and by app.effective_entitlements
-- treating a null limit as unlimited. Pointed at a database where something had written
-- real limits, these same assertions would fail, and that is correct.
--
-- It also exercises the isolation guarantee and the job lifecycle, because those are the
-- two things that would be most expensive to discover broken in production.
--
-- Claims are set with set_config rather than SET, so the same lines work inside a DO
-- block and at the top level.

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'ada@alpha.test'),
  ('22222222-2222-2222-2222-222222222222', 'grace@beta.test');

-- ---------------------------------------------------------------------------
-- Two tenants
-- ---------------------------------------------------------------------------

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  perform public.create_org('Alpha', 'alpha');
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  perform public.create_org('Beta', 'beta');
  reset role;

  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Unmetered by default
-- ---------------------------------------------------------------------------

do $$
declare
  e record;
begin
  select * into e from app.effective_entitlements(
    (select id from public.orgs where slug = 'alpha'));
  assert e.plan_code = 'unmetered', 'a fresh org should be unmetered, got ' || e.plan_code;
  assert e.max_jobs_per_month is null, 'no monthly job limit without a billing service';
  assert e.max_render_seconds_per_month is null, 'no monthly seconds limit without a billing service';
  assert e.max_stored_bytes is null, 'no storage limit without a billing service';
  -- The platform ceilings still apply, because they are the limits of the machine and
  -- not of a plan.
  assert e.max_job_seconds = 1800, 'the platform job ceiling should still apply';
  assert e.max_script_ops = 2000, 'the platform op ceiling should still apply';
  assert e.max_concurrent_renders = 8, 'the platform concurrency ceiling should still apply';
end
$$;

-- An org with no entitlement row at all, which is what a deployment that never ran
-- create_org's seed would look like, must still be usable.
do $$
declare
  e record;
  v_beta uuid := (select id from public.orgs where slug = 'beta');
begin
  delete from public.org_entitlements where org_id = v_beta;
  select * into e from app.effective_entitlements(v_beta);
  assert e.plan_code = 'unmetered', 'a missing entitlement row means unmetered';
  assert e.max_concurrent_renders = 8, 'a missing entitlement row still gets the ceiling';
  assert e.artifact_retention_days = 30, 'retention falls back to thirty days';
  insert into public.org_entitlements (org_id) values (v_beta);
end
$$;

-- ---------------------------------------------------------------------------
-- Submit, and idempotency
-- ---------------------------------------------------------------------------

do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'alpha');
  v_job public.render_jobs;
  a uuid;
  b uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

  v_job := public.submit_job(
    v_org,
    'web',
    '[{"op":"navigate","url":"https://kaviri.dev"},{"op":"click","selector":"#go"},{"op":"wait","ms":1200}]'::jsonb,
    '{"preset":"desktop"}'::jsonb,
    'test-key-0001');
  assert v_job.state = 'queued', 'a submitted job starts queued';
  assert v_job.attempt = 0, 'a submitted job has consumed no attempt';
  assert octet_length(v_job.script_sha256) = 32, 'the script should be content addressed';

  a := (public.submit_job(v_org, 'web', '[{"op":"wait","ms":10}]'::jsonb, '{}'::jsonb, 'dupe-key')).id;
  b := (public.submit_job(v_org, 'web', '[{"op":"wait","ms":10}]'::jsonb, '{}'::jsonb, 'dupe-key')).id;
  assert a = b, 'an idempotency key must resolve to the original job';

  -- Cancelled so the queue assertions below count only the job under test.
  assert public.request_cancel(a) = 'cancelled', 'a queued job cancels outright';

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- Isolation: Beta can neither read, count nor write Alpha
-- ---------------------------------------------------------------------------

do $$
declare
  n bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

  select count(*) into n from public.render_jobs;
  assert n = 0, 'Beta counted ' || n || ' of Alpha''s jobs';
  select count(*) into n from public.orgs;
  assert n = 1, 'Beta should see exactly its own org, saw ' || n;
  select count(*) into n from public.projects;
  assert n = 0, 'Beta should see none of Alpha''s projects, saw ' || n;
  select count(*) into n from public.usage_events;
  assert n = 0, 'Beta should see none of Alpha''s usage, saw ' || n;
  select count(*) into n from public.org_entitlements;
  assert n = 1, 'Beta should see only its own entitlements, saw ' || n;
  select count(*) into n from public.api_keys;
  assert n = 0, 'Beta should see none of Alpha''s keys, saw ' || n;

  begin
    insert into public.render_jobs (org_id, project_id, script, script_sha256)
    values ((select id from public.orgs where slug = 'alpha'),
            gen_random_uuid(), '[]'::jsonb, decode(repeat('00', 32), 'hex'));
    raise exception 'Beta managed to insert a job into Alpha';
  exception
    when insufficient_privilege or foreign_key_violation then null;
  end;

  -- Submitting through the RPC is fenced too, because SECURITY DEFINER turns RLS off and
  -- the function has to do the check itself.
  begin
    perform public.submit_job((select id from public.orgs where slug = 'alpha'),
      'web', '[{"op":"wait","ms":10}]'::jsonb);
    raise exception 'Beta submitted a job into Alpha through submit_job';
  exception
    when no_data_found then null;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- The worker path: lease, heartbeat, complete
-- ---------------------------------------------------------------------------

do $$
declare
  l record;
  l2 record;
  p record;
  c record;
begin
  set local role kaviri_worker;
  perform set_config('request.jwt.claims', '{"role":"kaviri_worker"}', true);

  select * into l from public.lease_next_job('worker-test-1', 120);
  assert l.job_id is not null, 'the queue handed out nothing';
  assert l.attempt = 1, 'the first lease is attempt 1, got ' || l.attempt;
  assert l.max_job_seconds = 1800, 'the worker should be told the platform job ceiling';
  assert jsonb_array_length(l.script) = 3, 'the worker should get the script verbatim';

  -- Nothing else is queued, so a second worker gets nothing rather than the same job.
  select * into l2 from public.lease_next_job('worker-test-2', 120);
  assert l2.job_id is null, 'a second worker leased a job that was not there';

  select * into p from public.report_progress(l.job_id, l.lease_token, 0.4, 'op 2 of 3', 'running');
  assert p.state = 'running', 'report_progress should have moved the job to running';
  assert p.cancel_requested = false, 'nothing asked for a cancel';

  -- A stale or invented token is refused. This is the whole of the fleet's authority
  -- model, so it gets an assertion rather than a comment.
  begin
    perform public.report_progress(l.job_id, gen_random_uuid(), 0.9, 'hijack', 'running');
    raise exception 'report_progress accepted a token it should not have';
  exception
    when insufficient_privilege then null;
  end;

  perform public.report_progress(l.job_id, l.lease_token, 0.95, 'uploading', 'uploading');

  -- Completing as done without a video is refused, because a done job with no artifact
  -- is a broken link in somebody's README.
  begin
    perform public.complete_job(l.job_id, l.lease_token, 'done', 30, '[]'::jsonb);
    raise exception 'complete_job accepted a done with no video';
  exception
    when invalid_parameter_value then null;
  end;

  select * into c from public.complete_job(
    l.job_id, l.lease_token, 'done', 92.4,
    jsonb_build_array(jsonb_build_object(
      'kind', 'video',
      'storage_key', 'orgs/alpha/' || l.job_id || '/take.mp4',
      'content_type', 'video/mp4',
      'bytes', 8123456,
      'duration_seconds', 21.4,
      'width', 1470,
      'height', 830)));
  assert c.state = 'done', 'the job should be done, is ' || c.state;

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- What the customer sees afterwards
-- ---------------------------------------------------------------------------

do $$
declare
  j public.render_jobs;
  a public.artifacts;
  u record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

  select * into j from public.render_jobs where state = 'done';
  assert j.id is not null, 'Alpha should see a done job';
  assert j.progress = 1, 'a done job reports full progress';
  assert j.finished_at is not null, 'a terminal job has a finish time';
  assert j.lease_token is null, 'a terminal job holds no lease';
  assert j.expires_at is not null, 'a done job has a retention deadline';
  assert j.render_seconds = 92.4, 'render seconds should be recorded on the job';
  assert j.error is null, 'a done job carries no error';

  select * into a from public.artifacts where job_id = j.id and kind = 'video';
  assert a.bytes = 8123456, 'the artifact should carry its size';
  assert a.expires_at is not null, 'the artifact should carry its retention deadline';

  select * into u from public.v_org_usage_month where org_id = j.org_id;
  assert u.jobs_submitted >= 1, 'the submission should be metered';
  assert u.jobs_completed = 1, 'the completion should be counted';
  assert u.render_seconds = 92.4, 'render seconds should reach the monthly view';
  assert u.plan_code = 'unmetered', 'the usage view carries a plan label and no money';

  -- The ledger is append only, and that is enforced rather than agreed.
  begin
    update public.usage_events set quantity = 0 where org_id = j.org_id;
    raise exception 'the usage ledger accepted an update';
  exception
    when insufficient_privilege then null;
  end;

  -- A customer cannot move their own job's state, only ask for a cancel.
  begin
    update public.render_jobs set state = 'queued' where id = j.id;
    raise exception 'a customer rewrote a job state';
  exception
    when insufficient_privilege then null;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- Beta still sees nothing of any of it.
do $$
declare
  n bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
  select count(*) into n from public.artifacts;
  assert n = 0, 'Beta counted ' || n || ' of Alpha''s artifacts';
  select count(*) into n from public.v_org_usage_month;
  assert n = 0, 'Beta saw ' || n || ' rows of Alpha''s usage';
  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- The state machine refuses what it should
-- ---------------------------------------------------------------------------

do $$
declare
  v_job uuid;
begin
  select id into v_job from public.render_jobs where state = 'done';
  begin
    update public.render_jobs set state = 'running' where id = v_job;
    raise exception 'a done job was moved back to running';
  exception
    when check_violation then null;
  end;

  -- The one legal edge out of done.
  update public.render_jobs set state = 'expired' where id = v_job;
  assert (select state from public.render_jobs where id = v_job) = 'expired',
    'done should be allowed to expire';
end
$$;

-- ---------------------------------------------------------------------------
-- The reaper puts a dead worker's job back, then gives up on it
-- ---------------------------------------------------------------------------

do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'alpha');
  v_job uuid;
  r record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  v_job := (public.submit_job(v_org, 'web', '[{"op":"wait","ms":10}]'::jsonb)).id;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  set local role kaviri_worker;
  perform public.lease_next_job('worker-that-dies', 15);
  reset role;

  -- The worker stops answering.
  update public.render_jobs set lease_expires_at = now() - interval '1 minute' where id = v_job;

  select * into r from public.reap_expired_leases(10) where job_id = v_job;
  assert r.new_state = 'queued', 'a reaped job with attempts left goes back to the queue';

  -- Out of attempts, it fails with a code the customer can act on. visible_at is pulled
  -- back because the reaper deliberately pushed it out as a backoff.
  update public.render_jobs
     set attempt = max_attempts, visible_at = now()
   where id = v_job;

  set local role kaviri_worker;
  perform public.lease_next_job('worker-that-also-dies', 15);
  reset role;

  update public.render_jobs set lease_expires_at = now() - interval '1 minute' where id = v_job;
  select * into r from public.reap_expired_leases(10) where job_id = v_job;
  assert r.new_state = 'failed', 'a reaped job out of attempts fails';
  assert (select error ->> 'code' from public.render_jobs where id = v_job) = 'lease_expired',
    'the failure should name itself';
  assert (select finished_at is not null from public.render_jobs where id = v_job),
    'a failed job has a finish time';
end
$$;

-- ---------------------------------------------------------------------------
-- API keys: the hash goes in, the key never comes out
-- ---------------------------------------------------------------------------

do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'alpha');
  v_secret text;
  v_key text;
  v_row public.api_keys;
  v_check record;
begin
  -- Base64 contains characters the key grammar rejects, so the edge uses a URL-safe
  -- alphabet. Mirrored here rather than assumed.
  v_secret := replace(replace(replace(
    encode(extensions.gen_random_bytes(24), 'base64'), '+', '-'), '/', '_'), '=', '');
  v_key := 'kv_7f3k4x2m_' || v_secret;

  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
  v_row := public.register_api_key(v_org, 'kv_7f3k4x2m', extensions.digest(v_key, 'sha256'), 'ci');
  assert v_row.prefix = 'kv_7f3k4x2m', 'the prefix should be stored for display';
  assert octet_length(v_row.key_hash) = 0, 'register_api_key must not hand the hash back';
  reset role;

  set local role kaviri_api;
  perform set_config('request.jwt.claims', '{"role":"kaviri_api"}', true);
  select * into v_check from app.verify_api_key(v_key);
  assert found, 'a good key should resolve';
  assert v_check.org_id = v_org, 'a good key should resolve to its own org';

  select * into v_check from app.verify_api_key('kv_7f3k4x2m_totallyWrongSecretValue');
  assert not found, 'a wrong secret must resolve to nothing';

  select * into v_check from app.verify_api_key('not-a-kaviri-key');
  assert not found, 'a malformed key must resolve to nothing';
  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- The seam, stated as an assertion rather than as prose
-- ---------------------------------------------------------------------------

-- Every key held in org_entitlements.extra_limits, at every depth. This is a view rather
-- than a query repeated inline because the assertions below run it four times: once on
-- the real rows, twice against planted keys, and once after the plant is removed.
--
-- The jsonpath is '$.**' rather than jsonb_object_keys so the walk reaches nested objects
-- and arrays. A key buried one level down is the same breach as a key at the top, and a
-- guard that read only the first level would be an instruction on where to hide.
-- The document itself is unioned in beside its descendants rather than relied on to come
-- back from '$.**', so that a top level key is covered by the plain reading of the query
-- and not by a property of the jsonpath operator that a reader would have to go and look
-- up. The duplicate root that this produces is harmless, since every caller takes distinct.
create temporary view seam_extra_limit_keys as
  select e.org_id, k
    from public.org_entitlements e
    cross join lateral (
      select e.extra_limits as v
      union all
      select jsonb_path_query(e.extra_limits, '$.**')
    ) d
    cross join lateral jsonb_object_keys(
      case when jsonb_typeof(d.v) = 'object' then d.v else '{}'::jsonb end) as k;

do $$
declare
  n integer;
  bad text;
  v_alpha uuid := (select id from public.orgs where slug = 'alpha');
  -- One word list for the column names and for the jsonb keys. The two checks are the
  -- same question asked of schema and of data, and a word added to one and forgotten in
  -- the other would reopen the gap the jsonb check exists to close.
  money_word constant text :=
    '(^|_)(price|amount|cost|currency|invoice|stripe|coupon|discount|subscription|mrr|arr|cents|tax_rate|payment|charge)($|_)';
begin
  select count(*) into n from information_schema.schemata where schema_name = 'billing';
  assert n = 0, 'the open migrations created a billing schema';

  select count(*) into n
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'org_entitlements'
     and column_name ~* money_word;
  assert n = 0, 'org_entitlements grew a column about money';

  -- extra_limits is jsonb, so its contents are data and not schema, and every guard in
  -- this repository that checks column NAMES passes it by whatever is inside it. A key
  -- such as seat_price_cents written by the billing service would land in the open
  -- database and satisfy the column assertion above, the DDL check in check-seam.sh and
  -- the catalogue check in verify-seam.sh, all three. So the keys are read out and held
  -- to the same word list as the columns.
  select string_agg(distinct k, ', ') into bad
    from seam_extra_limit_keys where k ~* money_word;
  assert bad is null,
    'org_entitlements.extra_limits holds key(s) about money: ' || coalesce(bad, '');

  -- The negative control. A guard nobody has watched fail has not been shown to guard
  -- anything, so the breach is committed here on purpose and the guard is required to
  -- name it. The plant is rolled back with the rest of this file.
  update public.org_entitlements
     set extra_limits = extra_limits || '{"seat_price_cents": 1200}'::jsonb
   where org_id = v_alpha;
  get diagnostics n = row_count;
  -- org_entitlements is FORCE RLS with no update policy, so this write needs a role that
  -- bypasses RLS. If it wrote nothing then the control proved nothing, and saying so is
  -- better than the silent pass that a missing plant would otherwise produce.
  assert n = 1,
    'the planted key was not written, so the extra_limits control proves nothing; run this file as a role that bypasses row level security';

  select string_agg(distinct k, ', ') into bad
    from seam_extra_limit_keys where k ~* money_word;
  assert bad = 'seat_price_cents',
    'the extra_limits guard missed a planted top level money key, got ' || coalesce(bad, '<nothing>');

  -- The same key one level down, because nesting is the obvious way around a guard that
  -- reads only the top level.
  update public.org_entitlements
     set extra_limits = '{"seats": {"price_cents": 1200}}'::jsonb
   where org_id = v_alpha;

  select string_agg(distinct k, ', ') into bad
    from seam_extra_limit_keys where k ~* money_word;
  assert bad = 'price_cents',
    'the extra_limits guard missed a planted nested money key, got ' || coalesce(bad, '<nothing>');

  -- Put it back, and confirm the guard goes quiet again. A check that reports a breach
  -- whatever the data says is not a check either.
  update public.org_entitlements set extra_limits = '{}'::jsonb where org_id = v_alpha;

  select string_agg(distinct k, ', ') into bad
    from seam_extra_limit_keys where k ~* money_word;
  assert bad is null,
    'the extra_limits guard still reports a key after the plant was removed: ' || coalesce(bad, '');

  -- Every tenant table has RLS on. A new table added without it would be readable by
  -- every other tenant, and this is the assertion that catches it on the day it lands.
  select count(*) into n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relkind = 'r'
     and c.relname in ('orgs','org_members','api_keys','projects','render_jobs',
                       'artifacts','usage_events','usage_counters','org_entitlements')
     and not (c.relrowsecurity and c.relforcerowsecurity);
  assert n = 0, n || ' tenant tables are missing forced row level security';
end
$$;

rollback;

\echo 'seam_none.sql: all assertions passed'
