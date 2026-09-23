-- Demo data for local development.
--
-- The point of a seed is to make the dashboard, the playground and the API worth opening
-- before a single real customer exists. So this is not two empty orgs: it is a queue with
-- something in every state a screen has to render, including the ugly ones. A job that
-- failed with an error, a job a customer cancelled, a job whose artifact has expired and
-- whose download link must therefore be gone. Those are the states that get shipped broken
-- when the seed only ever produces happy takes.
--
-- Everything is built through the real functions. submit_job, lease_next_job and
-- complete_job are the only ways a job, an artifact or a usage row is ever created in
-- production, so a seed that INSERTed directly would produce rows that cannot occur, and
-- would hide exactly the constraint violations this schema exists to enforce.
--
-- Safety: this refuses to run against a database that already holds orgs other than its
-- own, because the obvious accident is pointing it at the hosted project. Re-running it is
-- fine; it removes its own orgs first and rebuilds them.

\set ON_ERROR_STOP on

begin;

do $$
declare
  n bigint;
begin
  select count(*) into n from public.orgs
   where slug not in ('acme', 'globex');
  if n > 0 then
    raise exception
      'refusing to seed: this database already holds % org(s) that are not demo data', n
      using hint = 'seed.sql is for local development only, never the hosted project';
  end if;
end
$$;

-- Re-running the seed rebuilds it rather than accumulating a second copy. The cascade
-- reaches members, projects, jobs, artifacts and the ledger, because every one of them is
-- keyed on the org by design.
--
-- The ledger has to be unbolted first. usage_events cascades from orgs but also carries an
-- append-only trigger that refuses every DELETE, so the cascade raises and the org cannot
-- be removed at all. That is the right default for a real tenant, whose ledger should
-- outlive an accidental delete, and it is why production deletes an org by setting
-- orgs.deleted_at rather than by removing the row. A local rebuild is the one case that
-- genuinely wants the rows gone, so the trigger is lifted for exactly this statement and
-- put straight back.
alter table public.usage_events disable trigger usage_events_append_only;
delete from public.orgs where slug in ('acme', 'globex');
alter table public.usage_events enable trigger usage_events_append_only;
delete from auth.users where email in ('ada@acme.test', 'linus@acme.test', 'grace@globex.test');

insert into auth.users (id, email) values
  ('00000000-ac11-4000-8000-000000000001', 'ada@acme.test'),
  ('00000000-ac11-4000-8000-000000000002', 'linus@acme.test'),
  ('00000000-61b0-4000-8000-000000000001', 'grace@globex.test');

-- ---------------------------------------------------------------------------
-- Two tenants
-- ---------------------------------------------------------------------------

-- Acme is the one with history. Globex exists so that anything being developed against
-- this database is always being developed against more than one tenant, which is the only
-- reliable way to notice a query that forgot its org filter.
do $$
declare
  v_acme uuid;
begin
  set local role authenticated;

  perform set_config('request.jwt.claims',
    '{"sub":"00000000-ac11-4000-8000-000000000001","role":"authenticated"}', true);
  v_acme := (public.create_org('Acme Corp', 'acme')).id;

  perform set_config('request.jwt.claims',
    '{"sub":"00000000-61b0-4000-8000-000000000001","role":"authenticated"}', true);
  perform public.create_org('Globex', 'globex');

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- A second human in Acme, so the members screen has more than one row and so the
  -- difference between a member and an admin is visible without editing the database.
  insert into public.org_members (org_id, user_id, role)
  values (v_acme, '00000000-ac11-4000-8000-000000000002', 'member');
end
$$;

-- Acme's project carries defaults, because merging project defaults under a job's own
-- options is a behaviour with no test surface in the UI unless some project actually has
-- them.
do $$
declare
  v_acme uuid := (select id from public.orgs where slug = 'acme');
begin
  insert into public.projects (org_id, slug, name, default_options)
  values (v_acme, 'docs-site', 'Documentation site',
          '{"preset":"desktop","background":"#0b0b0c"}'::jsonb)
  on conflict (org_id, slug) do update set default_options = excluded.default_options;
end
$$;

-- An API key for each tenant. The secrets are fixed and public on purpose: they are in a
-- file in a public repository, they only ever unlock a local database full of invented
-- orgs, and a developer needs a key they can paste into curl without a registration
-- ceremony first. Nothing here is a credential for anything that exists.
--
--   Acme    kv_acmedemo_localdevelopmentkeyacme22222
--   Globex  kv_globdemo_localdevelopmentkeyglobex333
do $$
declare
  v_acme uuid := (select id from public.orgs where slug = 'acme');
  v_globex uuid := (select id from public.orgs where slug = 'globex');
begin
  set local role authenticated;

  perform set_config('request.jwt.claims',
    '{"sub":"00000000-ac11-4000-8000-000000000001","role":"authenticated"}', true);
  perform public.register_api_key(v_acme, 'kv_acmedemo',
    extensions.digest('kv_acmedemo_localdevelopmentkeyacme22222', 'sha256'),
    'local development');

  perform set_config('request.jwt.claims',
    '{"sub":"00000000-61b0-4000-8000-000000000001","role":"authenticated"}', true);
  perform public.register_api_key(v_globex, 'kv_globdemo',
    extensions.digest('kv_globdemo_localdevelopmentkeyglobex333', 'sha256'),
    'local development');

  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$$;

-- ---------------------------------------------------------------------------
-- A queue with something in every state a screen has to render
-- ---------------------------------------------------------------------------

-- The order below is load bearing. lease_next_job serves one global queue and takes the
-- oldest visible job regardless of tenant, exactly as it will in production, so a seed
-- that submits Acme's leftover queued take before Globex's take is filmed will hand
-- Acme's job to the worker meant for Globex and quietly attach Globex's video to it.
-- Every take is therefore filmed immediately after it is submitted, and the two jobs that
-- are meant to stay unfilmed are submitted last.
do $$
declare
  v_acme uuid := (select id from public.orgs where slug = 'acme');
  v_globex uuid := (select id from public.orgs where slug = 'globex');
  acme_claims text := '{"sub":"00000000-ac11-4000-8000-000000000001","role":"authenticated"}';
  glob_claims text := '{"sub":"00000000-61b0-4000-8000-000000000001","role":"authenticated"}';
  script jsonb := '[
    {"op":"navigate","url":"https://kaviri.dev"},
    {"op":"wait","ms":800},
    {"op":"type","selector":"#prompt","text":"record the onboarding flow"},
    {"op":"click","selector":"#run"},
    {"op":"wait","ms":2400}
  ]'::jsonb;
  l record;
  v_job uuid;
  v_to_expire uuid;
begin

  -- 1. The finished take most screens are designed against. Two artifacts, because the
  -- poster frame is a separate row and a card that renders one but not the other is a bug
  -- nobody sees until a customer has a poster.
  set local role authenticated;
  perform set_config('request.jwt.claims', acme_claims, true);
  perform public.submit_job(v_acme, 'docs-site', script, '{}'::jsonb, null,
    '{"repository":"acme/docs","ref":"refs/heads/main","commit":"9f1c2ab","run_id":"4412"}'::jsonb);
  reset role;

  set local role kaviri_worker;
  select * into l from public.lease_next_job('seed-worker-1', 300);
  perform public.report_progress(l.job_id, l.lease_token, 0.6, 'filming op 4 of 5', 'running');
  perform public.report_progress(l.job_id, l.lease_token, 0.95, 'uploading', 'uploading');
  perform public.complete_job(l.job_id, l.lease_token, 'done', 47.230,
    jsonb_build_array(
      jsonb_build_object('kind','video','storage_key','orgs/acme/'||l.job_id||'/take.mp4',
        'content_type','video/mp4','bytes',7340032,'duration_seconds',18.400,
        'width',1470,'height',830),
      jsonb_build_object('kind','poster','storage_key','orgs/acme/'||l.job_id||'/poster.webp',
        'content_type','image/webp','bytes',48210,'width',1470,'height',830)));
  reset role;

  -- 2. An older take that will be aged past its retention at the end, so the expired state
  -- has its own job rather than consuming the showcase one.
  set local role authenticated;
  perform set_config('request.jwt.claims', acme_claims, true);
  perform public.submit_job(v_acme, 'docs-site', script, '{"preset":"desktop"}'::jsonb);
  reset role;

  set local role kaviri_worker;
  select * into l from public.lease_next_job('seed-worker-1', 300);
  perform public.report_progress(l.job_id, l.lease_token, 0.5, 'filming', 'running');
  perform public.report_progress(l.job_id, l.lease_token, 0.9, 'uploading', 'uploading');
  perform public.complete_job(l.job_id, l.lease_token, 'done', 31.500,
    jsonb_build_array(jsonb_build_object(
      'kind','video','storage_key','orgs/acme/'||l.job_id||'/old-take.mp4',
      'content_type','video/mp4','bytes',5242880,'duration_seconds',14.100,
      'width',1470,'height',830)));
  reset role;
  v_to_expire := l.job_id;

  -- 3. A take that failed for good, so the error card has something to render. Marked not
  -- retryable, because a script pointing at a host that does not resolve films the same
  -- nothing however many times it is retried.
  set local role authenticated;
  perform set_config('request.jwt.claims', acme_claims, true);
  perform public.submit_job(v_acme, 'docs-site',
    '[{"op":"navigate","url":"https://does-not-resolve.invalid"},{"op":"wait","ms":500}]'::jsonb);
  reset role;

  set local role kaviri_worker;
  select * into l from public.lease_next_job('seed-worker-1', 300);
  perform public.complete_job(l.job_id, l.lease_token, 'failed', 3.100, '[]'::jsonb,
    '{"code":"navigation_failed",
      "message":"the page never loaded: DNS lookup for does-not-resolve.invalid failed",
      "op_index":0,
      "retryable":false}'::jsonb);
  reset role;

  -- 4. A take in flight, holding a live lease, which is what the progress bar is for. It
  -- stays leased, so it is out of the queue and cannot be handed to a later worker.
  set local role authenticated;
  perform set_config('request.jwt.claims', acme_claims, true);
  perform public.submit_job(v_acme, 'docs-site', script);
  reset role;

  set local role kaviri_worker;
  select * into l from public.lease_next_job('seed-worker-2', 900);
  perform public.report_progress(l.job_id, l.lease_token, 0.35, 'filming op 2 of 5', 'running', 900);
  reset role;

  -- 5. Globex has exactly one finished take. One is enough to make every cross-tenant
  -- mistake visible, and keeping it to one means a wrong count is obvious at a glance.
  -- Filmed here, while nothing else is queued, so the worker cannot pick up an Acme job.
  set local role authenticated;
  perform set_config('request.jwt.claims', glob_claims, true);
  perform public.submit_job(v_globex, 'storefront',
    '[{"op":"navigate","url":"https://globex.test"},{"op":"wait","ms":600}]'::jsonb);
  reset role;

  set local role kaviri_worker;
  select * into l from public.lease_next_job('seed-worker-3', 300);
  perform public.report_progress(l.job_id, l.lease_token, 0.5, 'filming op 1 of 2', 'running');
  perform public.report_progress(l.job_id, l.lease_token, 0.9, 'uploading', 'uploading');
  perform public.complete_job(l.job_id, l.lease_token, 'done', 12.900,
    jsonb_build_array(jsonb_build_object(
      'kind','video','storage_key','orgs/globex/'||l.job_id||'/take.mp4',
      'content_type','video/mp4','bytes',2097152,'duration_seconds',6.200,
      'width',1080,'height',1920)));
  reset role;

  -- 6 and 7. The two that stay unfilmed, submitted last so no worker above can take them.
  set local role authenticated;
  perform set_config('request.jwt.claims', acme_claims, true);
  perform public.submit_job(v_acme, 'marketing', script, '{"preset":"tiktok"}'::jsonb);

  v_job := (public.submit_job(v_acme, 'marketing', script)).id;
  perform public.request_cancel(v_job);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- 8. Age the second take past its retention and sweep it with the real function, so the
  -- row reaches 'expired' the way a real one will rather than by being written there.
  update public.render_jobs set expires_at = now() - interval '2 days' where id = v_to_expire;
  update public.artifacts set expires_at = now() - interval '2 days' where job_id = v_to_expire;
  perform public.expire_due_artifacts(100);
end
$$;

-- A little history, so a usage chart has a shape instead of a single bar. Written through
-- record_usage against earlier months, which keeps the ledger and the monthly counters
-- agreeing with each other exactly as they would have if the months had really passed.
do $$
declare
  v_acme uuid := (select id from public.orgs where slug = 'acme');
  m integer;
begin
  for m in 1..5 loop
    perform app.record_usage(v_acme, 'job_submitted', 1, null, null,
      '{"backfilled":true}'::jsonb, now() - make_interval(months => m));
    perform app.record_usage(v_acme, 'render_seconds', 40 + m * 17, null, null,
      '{"backfilled":true}'::jsonb, now() - make_interval(months => m));
    perform app.record_usage(v_acme, 'bytes_stored', 5000000 + m * 1200000, null, null,
      '{"backfilled":true}'::jsonb, now() - make_interval(months => m));
  end loop;
end
$$;

commit;

-- What the seed produced, so that running it prints something worth reading rather than
-- silence that could equally mean it did nothing.
select o.slug,
       count(*) filter (where j.state = 'done')      as done,
       count(*) filter (where j.state = 'failed')    as failed,
       count(*) filter (where j.state = 'running')   as running,
       count(*) filter (where j.state = 'queued')    as queued,
       count(*) filter (where j.state = 'cancelled') as cancelled,
       count(*) filter (where j.state = 'expired')   as expired
  from public.orgs o
  left join public.render_jobs j on j.org_id = o.id
 where o.slug in ('acme', 'globex')
 group by o.slug
 order by o.slug;
