# What is not production ready

Written 23 September 2026. Every line below is something I checked rather than assumed, and
where I could not check it the line says so. The point of this file is that nobody has to
rediscover any of it at three in the morning on launch day.

The short version: the recorder is ready, the landing page and the waitlist are live, the
database is applied and its whole job lifecycle is proven against the real Postgres, and the
edge Workers and the render fleet have still never served a request.

---

## Blocking, in the order they block each other

### 1. CI has never run. Not once. The cause is now known.

Every push to `thisisisheanesu/kaviri` is `startup_failure` with zero jobs created. The REST
API does not say why; the Actions tab does, in one line:

> GitHub Actions workflows can't be executed on this repository. Your account's billing is
> currently locked. Please update your payment information.

And `github.com/settings/billing/payment_information` says "You have not added a payment
method." There is $0.22 of metered usage this month from the ngano repository, $0 of it billed,
so this is not exhausted minutes: it is an account with a balance and no card, which locks
billing, which blocks Actions on every private repository.

Two ways out, and the second one is free:

1. Add a payment method. Nothing here will actually cost anything at this volume.
2. **Make the repository public.** Standard runners are free for public repositories, so there
   is nothing to bill and nothing to lock. The launch plan makes `kaviri` public anyway, so
   this is a sequencing choice rather than extra work.

**Worked around in the meantime.** `scripts/ci.sh` in both repositories runs what the workflow
runs, and `scripts/install-hooks.sh` wires it to a pre-push hook, so nothing reaches main
without passing. It is installed and it has already blocked one push. What it cannot do is
prove a clean checkout on another machine, and in this repository it cannot run the database
half at all, because that needs a Postgres to apply every migration to from scratch and there
is none here. The script prints that skip rather than passing quietly.

This is first because it invalidates every other check. The test suite is green on this laptop
and has never been green anywhere else.

### 2. The database schema is applied and proven. (Was blocking; no longer.)

Project **`qeprgqdekauxicawefpz`**, named kaviri, `eu-central-1`, Postgres 17.6, in inmisi's
Org. All twelve migrations are applied and the result was checked rather than assumed:

- 9 tables, every one with row level security on, and one view
- 11 functions in `public`, 16 in `app`, both `kaviri_api` and `kaviri_worker` roles
- pg_cron running `kaviri-reap-leases` every minute and `kaviri-expire-artifacts` hourly

A smoke test then took one job the whole way: submit, the same idempotency key returning the
same job rather than a second one, lease, a wrong lease token being refused, running,
uploading, complete with an artifact, the usage counters landing on 12.5 render seconds and
540,000 bytes, the state machine refusing `done -> running`, the ledger refusing both an update
and a bare delete, and finally the org deleting cleanly with nothing left behind. It cleaned up
after itself: the database is empty.

That last step is the one that found something. See `0012_deletable_orgs.sql`: **an org could
never be deleted once it had used the service once.** `usage_events` is append-only, enforced
by a trigger, and `usage_events.org_id` is `on delete cascade`, so the cascade hit its own
guard and the whole delete failed. Nobody had noticed because nothing had ever deleted an org.
It would have been found by the first account closure or the first deletion request under
GDPR, which is the worst possible place to find it. The guard now distinguishes the cascade
from a stray delete by whether the parent org still exists, which it does not during a cascade
and does in every other case.

### 2b. GitHub is connected to Supabase.

The Supabase GitHub App is installed on `thisisisheanesu`, scoped to `kaviri-cloud` alone
rather than all repositories, with deploy-to-production on and the production branch set to
`main`. Migrations now apply on every push.

One thing had to happen first, and it is the kind of thing that breaks the first sync: the
twelve migrations were applied by hand, so `supabase_migrations.schema_migrations` was empty
and the first sync would have tried to run all twelve again and failed on the first
`create table`. They are recorded as applied, which is what `supabase migration repair` does.
The next push carried `0012` and was the live test: nothing was re-applied, and the schema is
still 9 tables and 11 public functions.

### 3. Nothing is deployed.

Cloudflare account `67cb2eb6080019612e374af596f7197c` has one kaviri Worker on it:
`kaviri-site`, which is the landing page, the playground, the waitlist API and the admin. `workers/api` and `workers/dl` exist as source and have never
been deployed. There is no queue, no Durable Object namespace in use, and **R2 is not enabled
on that account at all** -- the API returns `Please enable R2 through the Cloudflare
Dashboard`. Artifact storage is R2 in the design.

There is also no render host. The cost model in `kaviri-billing/docs/PRICING.md` is priced
against a Hetzner AX102 that has not been rented.

### 4. `DEPLOY.md` names the wrong Cloudflare account.

It said kaviri.dev was in the Ishe@vambo.ai account. It is not: the zone is in
`67cb2eb6080019612e374af596f7197c`, the personal account, alongside ngano.dev and
glitchfront.com. The first deploy of the landing page followed the wrong id, uploaded a Worker
into the vambo account and failed to bind the domain, and the same id was in both Workers'
`wrangler.toml` and in the R2 setup script, where the failure would have been quieter.

Corrected in all five places on 23 September. Left here because it is the kind of thing that
comes back when somebody copies an old command out of their shell history.

### 5. Nobody can pay.

No code in `kaviri-billing` creates a Stripe Checkout session or a billing portal session. The
webhook handler is written and the plan limits are written, but the two endpoints that turn a
visitor into a subscriber do not exist. The three price ids are empty, deliberately, because
`PRICING-TBD.md` is unresolved. `docs/STRIPE.md` in that repository is the full list.

---

## Real, not blocking launch, but know about them

**Rate limiting fails open.** `workers/api/src/ratelimit.ts:39-58` catches any error from the
Durable Object stub and returns `allowed: true` with a full budget. The argument in the comment
is sound as far as it goes: `submit_job` enforces the limits that cost money, so a flood cannot
run up a bill. But the request rate limit itself is best effort, and it is bypassed by making
the Durable Object unreachable rather than by anything cleverer.

**`BILLING_MODE` enforces nothing.** It appears in the README, `.env.example`, `DEPLOY.md`, CI
and four comments, and no TypeScript, Rust or SQL reads it. The unmetered default comes entirely
from a LEFT JOIN in `app.effective_entitlements` finding no row. That is arguably the better
design, but `docs/API.md` says "under BILLING_MODE=none every tenant limit is null", and a
deployment that set it against a database where billing had already written entitlement rows
would still enforce those rows.

**The JSON guarantee stops at the Cloudflare edge.** The API promises a JSON body on every
response, and the Worker keeps that promise, but a WAF rule or a runtime error page (1101, CPU
limit) returns Cloudflare's HTML, which the GitHub Action cannot parse. `workers/api/README.md`
has a manual checklist for the zone configuration and nothing in CI asserts it.

**The container's own loopback is not fenceable.** Chromium's CDP endpoint listens on loopback
inside the render container, and the egress rules cannot reach inside the namespace. A page that
reached CDP could open `file://` inside its own container. One job per container bounds the
blast radius to that customer's own take. This is documented in `docker/README.md` and accepted,
not fixed.

**Zone configuration for kaviri.dev is unverified.** The four dashboard-only steps in
`site/wrangler.toml` -- SSL Full (strict), Always Use HTTPS, the two cache rules, the two rate
limiting rules -- are not confirmed. The OAuth token this machine holds cannot read zone
settings (`9109 Unauthorized`), so I can neither set nor check them. Until the rate limiting
rules exist, `demo.mp4` is a 500 KB file anyone can request in a loop.

**macOS is claimed and untested.** The README says Linux and macOS. It has only ever been built
and run on Linux. The CDP and ffmpeg paths are portable in principle; nothing has demonstrated
it.

---

## Not engineering, still blocking a public launch

- Both `kaviri` and `kaviri-cloud` are private. Going public is the launch, and it is one click
  each, but do it in the right order: `kaviri-cloud` still contains a `LAUNCH.md` that reads
  like an internal memo.
- No trademark search has been done. `kaviri` needs USPTO and EUIPO in classes 9 and 42. Under
  Apache 2.0 the trademark is the only thing separating your hosted service from someone else's
  copy of it, so this is load bearing rather than administrative.
- CLA against DCO is undecided, and `CLA.md` in the recorder repository is a draft that assumes
  the answer. Until an entity exists to assign to, neither can be signed.
- Nothing is published: no crates.io release, no GitHub release with binaries, no Marketplace
  listing for the Action. The install instructions on kaviri.dev currently describe a build from
  a repository nobody can see.
