# The kaviri database

The dedicated Supabase project, the scripts that build it, and the tests that prove it
behaves.

| | |
|---|---|
| project ref | `qeprgqdekauxicawefpz` |
| name | `kaviri` |
| region | `eu-central-1`, matching the other Vambo projects |
| Postgres | 17.6 |
| API URL | `https://qeprgqdekauxicawefpz.supabase.co` |

Nothing in this repository holds a credential for it. The Supabase access token comes from
the desktop keyring where the CLI already keeps it, or from `SUPABASE_ACCESS_TOKEN`. The
database password was generated at creation and stored in the keyring under
`kaviri supabase db password (qeprgqdekauxicawefpz)`; it was never written to a file and is
not needed for anything here, because every script goes through the Management API or
through `psql` with a URL you supply.

## Getting SQL into the database

There is one entry point, `scripts/run-sql.py`, and it picks a route:

| you have | route |
|---|---|
| `DATABASE_URL` and `psql` on PATH | psql, which is what CI uses |
| `SUPABASE_PROJECT_REF` | the Supabase Management API query endpoint |

That split exists because the two audiences genuinely differ. CI brings up a
`postgres:16` container and has psql. A laptop pointed at the hosted project usually has
neither psql nor the database password, but does have a Supabase token.

```sh
export SUPABASE_PROJECT_REF=qeprgqdekauxicawefpz     # hosted
# or
export DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres
```

## The scripts

```sh
scripts/reset.sh            # drop, apply all ten migrations, seed
scripts/reset.sh --no-seed  # schema only, which is what CI wants before the tests
scripts/test-isolation.sh   # tenant isolation, and proof the test can fail
scripts/verify-seam.sh      # no billing surface in the applied schema
scripts/check-seam.sh       # no billing logic in the source (no database needed)
```

`reset.sh` and `seed.sql` both refuse to touch a database holding any org that is not
demo data. The accident they exist to prevent is a production connection string left
exported in the shell, so the guard is blunt on purpose. `reset.sh --force` overrides it.

## The seed

Two tenants, and a queue with one job in every state a screen has to render:

```
acme    done 1  failed 1  running 1  queued 1  cancelled 1  expired 1
globex  done 1
```

Everything is built through `submit_job`, `lease_next_job`, `report_progress` and
`complete_job`, because those are the only ways a job, an artifact or a usage row comes
into existence in production. A seed that inserted rows directly would produce states the
state machine forbids, and would hide exactly the constraints this schema exists to
enforce. It caught two mistakes while being written, which is the argument for doing it
this way.

The order the seed submits and films in is load bearing: `lease_next_job` serves one
global queue across all tenants, so each take is filmed immediately after it is submitted
and the two jobs meant to stay unfilmed are submitted last.

Demo API keys, fixed and public because they only ever unlock a local database of invented
orgs:

```
acme    kv_acmedemo_localdevelopmentkeyacme22222
globex  kv_globdemo_localdevelopmentkeyglobex333
```

## The isolation test

`supabase/tests/isolation.sql` builds two tenants that each own one of everything, then
asks from inside each tenant's session how much of the other it can see. It covers both
ways a caller reaches `app.is_org_member`:

- a human, role `authenticated`, membership resolved through `org_members`
- a machine, role `kaviri_api`, membership being the single `kaviri_org` claim

and asserts on jobs, artifacts, usage events, usage counters, the monthly usage view, orgs,
members, projects, entitlements and API keys, in both directions, for reads, for counts,
for lookups by primary key, and for cross-tenant writes through both the table and the RPC.

The whole file runs in one transaction that rolls back, so it is safe to point at the
deployed project, which is the point: the guarantee is about the database customers use,
not about a container that resembles it.

`scripts/test-isolation.sh` runs it twice. Once as written, which must pass, and once with
`render_jobs_select_member` widened to `using (true)`, which must fail. Without the second
run a test that has quietly stopped asserting is indistinguishable from one that passes.

Two things worth knowing if you edit it:

- The connecting role is a superuser and bypasses RLS, so the file asserts that up front.
  Forgetting to `set local role` is the failure mode that makes an isolation test pass
  unconditionally.
- Fixture jobs are given `priority = 1000` so they win the shared queue even when the
  demo data is present.

## The seam

Two checks, and both are needed.

`check-seam.sh` reads the source and refuses billing logic in it. `verify-seam.sh`
interrogates the applied catalogue, because a migration can reference no billing schema
and still create one through a `DO` block or a composed `EXECUTE`, and because a column
named innocently in the DDL is still a price if it holds one. It also runs the
`BILLING_MODE=none` claim as a test: a brand new org comes out unmetered, with null limits
and only the platform ceilings.

Planting `stripe_price_id` on `org_entitlements` is caught by `verify-seam.sh` and not by
`check-seam.sh`, which is the clearest illustration of why the schema half exists.
