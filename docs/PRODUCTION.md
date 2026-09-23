# What is not production ready

Written 23 September 2026. Every line below is something I checked rather than assumed, and
where I could not check it the line says so. The point of this file is that nobody has to
rediscover any of it at three in the morning on launch day.

The short version: the recorder is ready, the landing page is live, and the hosted service has
never run. Not "has bugs" -- has never had a single request served by any part of it.

---

## Blocking, in the order they block each other

### 1. CI has never run. Not once.

Every push to `thisisisheanesu/kaviri` since 22 September is `startup_failure` with zero jobs
created. Both workflow files parse as valid YAML, `action.yml` parses, and repository level
Actions permissions are `{"enabled": true, "allowed_actions": "all"}`. A startup failure with
no jobs and a valid workflow is almost always account level: Actions billing, a spending limit
at zero, or included minutes exhausted on private repositories.

This is first because it invalidates every other check. The test suite is green on this laptop
and has never been green anywhere else. Look at github.com/settings/billing.

### 2. The database schema has never been proved against a real Postgres.

Corrected on 23 September, because the earlier version of this file was wrong in a way worth
recording: the project id in `DEPLOY.md` was `dewjjmvsnojnmqhbvuxx`, and that project **is not
on this account**. It is absent from all four organisations the account can see. Its REST
endpoint answers 401, which looked like proof the project existed, and is not: an unknown ref
on the `supabase.co` wildcard answers 401 too. A 401 from a hostname proves a hostname.

A real project now exists: **`qeprgqdekauxicawefpz`**, named kaviri, `eu-central-1`, in
`inmisi's Org`, created through the Management API and confirmed by running
`select current_database()` against it.

The eleven migrations are still not applied. `scripts/run-sql.py` reads its access token from
the desktop keyring, where there is no longer one (`No such secret item at path:
/org/freedesktop/secrets/collection/login/10`), and there is no Postgres on this machine to
apply them to locally. One `npx supabase login` puts the token back and `./scripts/reset.sh`
can then run. Until it has, two defects the audit found in `0011` are fixed in the tree, which
is a different claim from "applies cleanly".

### 3. Nothing is deployed.

Cloudflare account `67cb2eb6080019612e374af596f7197c` has exactly one kaviri Worker on it:
`kaviri-site`, the landing page. `workers/api` and `workers/dl` exist as source and have never
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
