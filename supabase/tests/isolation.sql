-- Tenant isolation, asserted against a real Postgres.
--
-- Row Level Security that has only ever been read is decoration. The policies in the
-- migrations are short enough to look obviously correct and that is exactly the danger:
-- a policy that is never exercised cannot be told apart from a policy that is missing,
-- because both produce a working single-tenant system. This file builds two tenants that
-- each own one of everything and then asks, from inside each tenant's session, how much
-- of the other one it can see. The only acceptable answer is none.
--
-- It is written to be safe against a live project. Everything happens inside one
-- transaction that rolls back at the end, so running it against the deployed kaviri
-- database leaves no orgs, no jobs and no ledger rows behind. That matters because the
-- guarantee is about the deployed database, and a test that can only run against a
-- throwaway container is testing a different database than the one customers use.
--
-- Two sessions are simulated the way the edge actually presents them:
--
--   a human    role authenticated, a "sub" claim, membership resolved through org_members
--   a machine  role kaviri_api, a "kaviri_org" claim, membership being that one claim
--
-- Both are covered, because they reach app.is_org_member by different branches and an
-- error in either one is a cross-tenant read in production.
--
-- Run it with scripts/test-isolation.sh.

\set ON_ERROR_STOP on

begin;

-- The connection that applies migrations is a superuser, and a superuser bypasses RLS
-- entirely. Asserting isolation without leaving that role would pass no matter what the
-- policies said, so this is checked once, loudly, before anything is trusted below.
do $$
begin
  assert (select rolbypassrls from pg_roles where rolname = current_user),
    'expected to start as a role that bypasses RLS, so that dropping to authenticated is a real change';
end
$$;

-- Slugs are unique across all tenants, so the fixtures are named for this test rather
-- than for the demo data in seed.sql, which may be present in the same database.
create temp table iso (k text primary key, v uuid) on commit drop;

-- The temp table belongs to the connecting superuser, and most of this file runs after
-- dropping to authenticated or kaviri_api. Without this the test fails on its own
-- scratch space rather than on anything it is trying to prove.
grant all on iso to public;

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'ada@iso-alpha.test'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'grace@iso-beta.test');

-- ---------------------------------------------------------------------------
-- Two tenants, each owning one of everything
-- ---------------------------------------------------------------------------

do $$
declare
  v_org uuid;
begin
  set local role authenticated;

  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
  v_org := (public.create_org('Iso Alpha', 'iso-alpha')).id;
  insert into iso values ('alpha_org', v_org);

  perform set_config('request.jwt.claims',
    '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
  v_org := (public.create_org('Iso Beta', 'iso-beta')).id;
  insert into iso values ('beta_org', v_org);

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- Each tenant submits a take, a worker films it, and it finishes with a video. This is
-- done for both so that every table under test holds exactly one row per tenant, which
-- makes "saw zero" and "saw one" the only two interesting counts below.
do $$
declare
  r record;
  v_org uuid;
  v_job uuid;
  l record;
  slug text;
begin
  for r in select * from (values ('alpha'), ('beta')) as t(who)
  loop
    slug := 'iso-' || r.who;
    select v into v_org from iso where k = r.who || '_org';

    set local role authenticated;
    perform set_config('request.jwt.claims',
      case r.who
        when 'alpha' then '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}'
        else '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}'
      end, true);

    v_job := (public.submit_job(
      v_org, 'site',
      '[{"op":"navigate","url":"https://kaviri.dev"},{"op":"wait","ms":500}]'::jsonb,
      '{"preset":"desktop"}'::jsonb)).id;
    insert into iso values (r.who || '_job', v_job);

    -- An API key per tenant, so the key table is covered too. The secret is generated the
    -- way the edge generates it and only its hash is ever stored.
    perform public.register_api_key(
      v_org,
      case r.who when 'alpha' then 'kv_aaaaaaaa' else 'kv_bbbbbbbb' end,
      extensions.digest('kv_key_for_' || r.who, 'sha256'),
      r.who || '-ci');

    reset role;
    perform set_config('request.jwt.claims', '', true);

    -- lease_next_job serves one queue for the whole platform, ordered by priority and then
    -- by age. If this database already holds demo data with something queued, the worker
    -- below would lease that instead and the test would fail describing the wrong problem.
    -- Priority is raised so the fixtures win the queue whatever else is waiting, which is
    -- what lets this file be pointed at a seeded database. It is done after dropping back
    -- out of authenticated, whose only update grant on render_jobs is cancel_requested.
    update public.render_jobs set priority = 1000 where id = v_job;

    -- The fleet takes the job and completes it, which is the only path that creates an
    -- artifact row and the only path that meters render seconds.
    set local role kaviri_worker;
    select * into l from public.lease_next_job('iso-worker-' || r.who, 120);
    assert l.job_id = v_job, 'the queue handed out the wrong job for ' || r.who;
    perform public.report_progress(l.job_id, l.lease_token, 0.5, 'filming', 'running');
    perform public.report_progress(l.job_id, l.lease_token, 0.9, 'uploading', 'uploading');
    perform public.complete_job(
      l.job_id, l.lease_token, 'done', 10.5,
      jsonb_build_array(jsonb_build_object(
        'kind', 'video',
        'storage_key', 'orgs/' || slug || '/' || l.job_id || '/take.mp4',
        'content_type', 'video/mp4',
        'bytes', 1048576,
        'duration_seconds', 4.0,
        'width', 1470,
        'height', 830)));
    reset role;
  end loop;

  perform set_config('request.jwt.claims', '', true);
end
$$;

-- The fixtures are only worth something if they actually exist. Checked from the
-- bypassing role, because this is a statement about the database and not about a tenant.
do $$
declare
  n bigint;
begin
  select count(*) into n from public.render_jobs
   where org_id in (select v from iso where k like '%_org');
  assert n = 2, 'expected one job per tenant, found ' || n;

  select count(*) into n from public.artifacts
   where org_id in (select v from iso where k like '%_org');
  assert n = 2, 'expected one artifact per tenant, found ' || n;

  select count(*) into n from public.usage_events
   where org_id in (select v from iso where k like '%_org');
  assert n > 0, 'expected the tenants to have metered usage, found none';
end
$$;

-- ---------------------------------------------------------------------------
-- The question this file exists to ask, in both directions
-- ---------------------------------------------------------------------------

-- Both tenants are checked with the same body rather than two hand-written blocks,
-- because isolation that holds one way and not the other is the failure that a
-- copy-pasted and half-edited second block is most likely to hide.
do $$
declare
  r record;
  n bigint;
  mine uuid;
  theirs uuid;
  claims text;
begin
  for r in select * from (values ('alpha', 'beta'), ('beta', 'alpha')) as t(who, other)
  loop
    select v into mine from iso where k = r.who || '_org';
    select v into theirs from iso where k = r.other || '_org';
    claims := case r.who
      when 'alpha' then '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}'
      else '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}'
    end;

    set local role authenticated;
    perform set_config('request.jwt.claims', claims, true);

    -- Jobs. Scoped to the other tenant's org id rather than counting the whole table,
    -- so that demo data from seed.sql cannot make a leak look like a pass or a pass look
    -- like a leak.
    select count(*) into n from public.render_jobs where org_id = theirs;
    assert n = 0, r.who || ' could see ' || n || ' of ' || r.other || '''s jobs';

    -- The same question asked without naming the org, which is what a client that simply
    -- lists its jobs actually sends. It must see its own one row and nothing more.
    select count(*) into n from public.render_jobs;
    assert n = 1, r.who || ' listing all jobs saw ' || n || ', expected only its own 1';

    select count(*) into n from public.artifacts where org_id = theirs;
    assert n = 0, r.who || ' could see ' || n || ' of ' || r.other || '''s artifacts';
    select count(*) into n from public.artifacts;
    assert n = 1, r.who || ' listing all artifacts saw ' || n || ', expected only its own 1';

    select count(*) into n from public.usage_events where org_id = theirs;
    assert n = 0, r.who || ' could see ' || n || ' of ' || r.other || '''s usage events';
    select count(*) into n from public.usage_counters where org_id = theirs;
    assert n = 0, r.who || ' could see ' || r.other || '''s usage counters';
    select count(*) into n from public.v_org_usage_month where org_id = theirs;
    assert n = 0, r.who || ' could see ' || r.other || '''s monthly usage view';

    -- The remaining tenant-scoped tables, so that isolation is a property of the schema
    -- rather than of the three tables the assignment happened to name.
    select count(*) into n from public.orgs where id = theirs;
    assert n = 0, r.who || ' could see the ' || r.other || ' org row';
    select count(*) into n from public.projects where org_id = theirs;
    assert n = 0, r.who || ' could see ' || r.other || '''s projects';
    select count(*) into n from public.org_members where org_id = theirs;
    assert n = 0, r.who || ' could see ' || r.other || '''s members';
    select count(*) into n from public.org_entitlements where org_id = theirs;
    assert n = 0, r.who || ' could see ' || r.other || '''s entitlements';
    select count(*) into n from public.api_keys where org_id = theirs;
    assert n = 0, r.who || ' could see ' || r.other || '''s API keys';

    -- Reading a specific row by its primary key, which is the shape an attacker uses
    -- when an id has leaked into a log or a URL. A count of zero above would still be
    -- consistent with a policy that permits a direct lookup.
    select count(*) into n from public.render_jobs
     where id = (select v from iso where k = r.other || '_job');
    assert n = 0, r.who || ' fetched ' || r.other || '''s job by id';

    -- Writing into the other tenant, through the table and through the RPC. The RPC
    -- needs its own assertion because SECURITY DEFINER switches RLS off, so the fence
    -- there is a line of plpgsql rather than a policy.
    begin
      insert into public.render_jobs (org_id, project_id, script, script_sha256)
      values (theirs, gen_random_uuid(), '[]'::jsonb, decode(repeat('00', 32), 'hex'));
      raise exception '% inserted a job into %', r.who, r.other;
    exception
      when insufficient_privilege or foreign_key_violation or check_violation then null;
    end;

    begin
      perform public.submit_job(theirs, 'site', '[{"op":"wait","ms":10}]'::jsonb);
      raise exception '% submitted a job into % through submit_job', r.who, r.other;
    exception
      when no_data_found then null;
    end;

    -- Cancelling somebody else's job must be indistinguishable from the job not
    -- existing, or the endpoint becomes a way to probe which ids are real.
    begin
      perform public.request_cancel((select v from iso where k = r.other || '_job'));
      raise exception '% cancelled %''s job', r.who, r.other;
    exception
      when no_data_found then null;
    end;

    reset role;
    perform set_config('request.jwt.claims', '', true);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The machine path, which is how production traffic actually arrives
-- ---------------------------------------------------------------------------

-- A leaked API key is the realistic threat, and it reaches app.is_org_member through the
-- claim branch rather than the org_members branch. The two branches are separate code,
-- so a fix to one does not test the other.
do $$
declare
  r record;
  n bigint;
  mine uuid;
  theirs uuid;
begin
  for r in select * from (values ('alpha', 'beta'), ('beta', 'alpha')) as t(who, other)
  loop
    select v into mine from iso where k = r.who || '_org';
    select v into theirs from iso where k = r.other || '_org';

    set local role kaviri_api;
    perform set_config('request.jwt.claims',
      json_build_object('role', 'kaviri_api', 'kaviri_org', mine)::text, true);

    select count(*) into n from public.render_jobs where org_id = theirs;
    assert n = 0, 'an API key for ' || r.who || ' saw ' || n || ' of ' || r.other || '''s jobs';
    select count(*) into n from public.artifacts where org_id = theirs;
    assert n = 0, 'an API key for ' || r.who || ' saw ' || r.other || '''s artifacts';
    select count(*) into n from public.usage_events where org_id = theirs;
    assert n = 0, 'an API key for ' || r.who || ' saw ' || r.other || '''s usage';

    -- It can still do its own job, or the fence would be indistinguishable from the
    -- service being broken.
    select count(*) into n from public.render_jobs where org_id = mine;
    assert n = 1, 'an API key for ' || r.who || ' could not see its own job';

    begin
      perform public.submit_job(theirs, 'site', '[{"op":"wait","ms":10}]'::jsonb);
      raise exception 'an API key for % submitted into %', r.who, r.other;
    exception
      when no_data_found then null;
    end;

    -- A key may submit takes and must not be able to mint another key or read the key
    -- list, so that stealing one key does not become stealing every future key.
    begin
      perform public.register_api_key(mine, 'kv_zzzzzzzz',
        extensions.digest('nope', 'sha256'), 'escalation');
      raise exception 'an API key for % minted another key', r.who;
    exception
      when insufficient_privilege then null;
    end;

    -- kaviri_api holds no grant on api_keys at all, so the expected answer here is a
    -- privilege error rather than an empty result: the column-level grant in 0004 names
    -- only authenticated. Both outcomes are the guarantee, and asserting on rows alone
    -- would make this pass for the wrong reason if a grant were ever widened.
    begin
      select count(*) into n from public.api_keys;
      assert n = 0, 'an API key for ' || r.who || ' could enumerate ' || n || ' keys';
    exception
      when insufficient_privilege then null;
    end;

    reset role;
    perform set_config('request.jwt.claims', '', true);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- An anonymous caller is nobody's tenant
-- ---------------------------------------------------------------------------

do $$
declare
  n bigint;
begin
  set local role anon;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  -- anon holds no grant on these tables at all, so the expected outcome is a privilege
  -- error rather than an empty result. Either one is isolation; the assertion accepts
  -- the error and fails on any row.
  begin
    select count(*) into n from public.render_jobs;
    assert n = 0, 'an anonymous caller saw ' || n || ' jobs';
  exception
    when insufficient_privilege then null;
  end;

  begin
    select count(*) into n from public.orgs;
    assert n = 0, 'an anonymous caller saw ' || n || ' orgs';
  exception
    when insufficient_privilege then null;
  end;

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

select 'isolation: every cross-tenant read returned nothing and every cross-tenant write was refused' as result;

-- Nothing this file created survives it, which is what makes it safe to point at the
-- deployed database rather than only at a container.
rollback;
