-- The proof that a render job cannot be created except through public.submit_job.
--
-- render_jobs used to carry an INSERT grant to authenticated and kaviri_api, with an RLS
-- policy that checked only org membership. PostgREST is a public endpoint and the anon key
-- is public by design, so any signed-in user could POST a row straight to
-- /rest/v1/render_jobs. That row was born queued, satisfied the birth trigger, and
-- lease_next_job rendered it like any other. Everything that makes submit_job more than an
-- insert was therefore optional: the script op ceiling, the three monthly limits, the
-- idempotency resolution and the usage ledger.
--
-- This test does not assert that the grant is absent, because asserting on a catalog is
-- asserting on the fix rather than on the behaviour. It performs the attack and asserts it
-- is refused, then performs the legitimate path and asserts it is allowed, then asserts the
-- usage ledger moved only for the legitimate one. A fence that is present but not load
-- bearing would pass the first assertion and fail the last.
--
-- Claims are set with set_config rather than SET, so the same lines work inside a DO block
-- and at the top level.

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'lovelace@gamma.test');

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
  perform public.create_org('Gamma', 'gamma');
  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- A project to aim the forged insert at. Creating it directly is legitimate: 0004 grants
-- insert on projects to a member on purpose, so that a new repository's first workflow run
-- produces a video instead of failing on setup. It also means the forged render_jobs insert
-- below is refused for exactly one reason, the missing privilege, and not because it
-- referenced a project that did not exist.
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'gamma');
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
  insert into public.projects (org_id, slug, name) values (v_org, 'web', 'web');
  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- The attack, as the authenticated role
-- ---------------------------------------------------------------------------

-- This is the shape a session JWT would POST to /rest/v1/render_jobs. The row is valid in
-- every other respect: the org is one this user really is a member of, so the RLS policy
-- would pass, the state is the queued the birth trigger demands, and the script is a
-- well formed array with a correctly sized digest. Only the privilege stops it.
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'gamma');
  v_project uuid := (select id from public.projects where slug = 'web');
  v_refused boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

  begin
    insert into public.render_jobs (org_id, project_id, script, script_sha256, options)
    values (v_org, v_project, '[{"kind":"wait","ms":1}]'::jsonb,
            extensions.digest('forged', 'sha256'), '{}'::jsonb);
  exception
    when insufficient_privilege then
      v_refused := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_refused,
    'a direct insert into render_jobs as authenticated was accepted, so the entitlement '
    'fence and the usage ledger in submit_job are both optional';
end
$$;

-- ---------------------------------------------------------------------------
-- The same attack as kaviri_api
-- ---------------------------------------------------------------------------

-- kaviri_api is the role the edge Worker holds once it has resolved an API key. It had the
-- same insert grant, so a bug or an injection anywhere in the Worker reached the same
-- bypass without needing a session JWT at all.
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'gamma');
  v_project uuid := (select id from public.projects where slug = 'web');
  v_refused boolean := false;
begin
  set local role kaviri_api;
  perform set_config('request.jwt.claims',
    '{"role":"kaviri_api","kaviri_org":"' || v_org || '"}', true);

  begin
    insert into public.render_jobs (org_id, project_id, script, script_sha256, options)
    values (v_org, v_project, '[{"kind":"wait","ms":1}]'::jsonb,
            extensions.digest('forged-api', 'sha256'), '{}'::jsonb);
  exception
    when insufficient_privilege then
      v_refused := true;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_refused,
    'a direct insert into render_jobs as kaviri_api was accepted, so the edge role can '
    'still queue work that no limit was checked against';
end
$$;

-- Neither forged row may exist. Checked separately from the refusal above because an
-- insert that raised and was then swallowed by some trigger would still satisfy the
-- assertions so far.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.render_jobs;
  assert v_count = 0,
    'render_jobs should be empty after two refused inserts, found ' || v_count || ' rows';
end
$$;

-- ---------------------------------------------------------------------------
-- The legitimate path still works
-- ---------------------------------------------------------------------------

-- Revoking the grant is only correct if submit_job is unaffected by it. submit_job is
-- SECURITY DEFINER, so its insert runs as the table owner rather than as the caller, and
-- the insert policy that 0005 keeps is what lets that owner insert under FORCE ROW LEVEL
-- SECURITY. If either half of that were wrong, the service would be fixed and dead.
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'gamma');
  v_job public.render_jobs;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

  v_job := public.submit_job(v_org, 'web', '[{"kind":"wait","ms":1}]'::jsonb);

  reset role;
  perform set_config('request.jwt.claims', '', true);

  assert v_job.id is not null, 'submit_job returned no job';
  assert v_job.state = 'queued', 'a submitted job should be queued, got ' || v_job.state;
end
$$;

-- ---------------------------------------------------------------------------
-- The ledger is no longer optional
-- ---------------------------------------------------------------------------

-- This is the assertion the whole test exists for. Three jobs were attempted and one was
-- accepted, so the counter must read exactly one. If a forged insert had landed, the
-- counter would disagree with the row count, which is precisely the off the books
-- rendering the grant made possible: work the fleet performs and the ledger never sees.
do $$
declare
  v_org uuid := (select id from public.orgs where slug = 'gamma');
  v_submitted bigint;
  v_rows integer;
begin
  select coalesce(c.jobs_submitted, 0) into v_submitted
    from public.usage_counters c
   where c.org_id = v_org and c.period_month = app.month_of(now());

  select count(*) into v_rows from public.render_jobs where org_id = v_org;

  assert v_submitted = 1,
    'the usage ledger should have recorded exactly one submitted job, got '
    || coalesce(v_submitted::text, 'no counter row');
  assert v_rows = 1,
    'exactly one render job should exist, got ' || v_rows;
  assert v_submitted = v_rows,
    'the ledger and the queue disagree, which means a job reached the fleet off the books';
end
$$;

rollback;
