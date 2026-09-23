# Standing kaviri cloud up from nothing

The ordered steps, including the ones that can only be done by hand in a dashboard.

Read this straight through once before starting. Several steps produce a value a later
step consumes, and two of them are one-way: the R2 bucket's location cannot be changed
after creation, and a Supabase project's region cannot be changed at all.

Nothing in this document contains a secret. Every secret is generated during the run and
put straight into `wrangler secret put`, `systemd` or the keyring. If you find yourself
pasting one into a file, stop: `.gitignore` covers `.env*`, but the habit is the problem.

## What already exists

| | |
|---|---|
| Cloudflare account | `67cb2eb6080019612e374af596f7197c` (the personal account) |
| Domain | `kaviri.dev`, live on Cloudflare in that account, alongside ngano.dev |
| Landing page | Worker `kaviri-site`, on the apex and on www |
| Mail | Email Routing on, `hello@` forwards, everything else drops |
| Supabase project | `dewjjmvsnojnmqhbvuxx`, region `eu-central-1`, Postgres 17.6 |
| Supabase URL | `https://dewjjmvsnojnmqhbvuxx.supabase.co` |

The database password was generated at project creation and is in the GNOME keyring, not
on disk. The Supabase access token is read from the same keyring by `scripts/run-sql.py`.

If you are standing up a *second* environment rather than this one, create the Supabase
project in `eu-central-1` to match, and substitute its ref everywhere below.

---

## 1. The database

`scripts/run-sql.py` picks its route for you: `psql` when `DATABASE_URL` is set, which is
what CI uses, and the Supabase Management API when `SUPABASE_PROJECT_REF` is set, which is
what a laptop with no `psql` uses.

```
export SUPABASE_PROJECT_REF=dewjjmvsnojnmqhbvuxx
./scripts/reset.sh            # drops, applies every migration in order, seeds demo data
./scripts/reset.sh --no-seed  # schema only, which is what a real environment wants
```

`reset.sh` drops the `public` schema. On a database with customers in it that is the whole
service, so it has a guard and `--force` exists only for the case where you really mean it.

To apply to an environment that already has data, run the migrations individually rather
than resetting:

```
./scripts/run-sql.py supabase/migrations/*.sql
```

Then confirm the three things the rest of the system assumes:

```
./scripts/verify-seam.sh                        # no billing surface in the applied schema
./scripts/test-isolation.sh                     # tenant isolation, with its negative control
./scripts/run-sql.py supabase/tests/seam_none.sql
```

`seam_none.sql` expects an unseeded schema. It leases a job from the global queue and
asserts the script it gets back, so a seeded database hands it somebody else's take and it
fails on an assertion that has nothing to do with what broke. Run it after
`reset.sh --no-seed`, which is the order CI uses.

### By hand in the Supabase dashboard

1. **Do not expose the `app` schema to PostgREST.** Settings, API, Exposed schemas: leave
   it as `public` (and `graphql_public` if it is already there). Migration `0011` puts the
   two functions the edge needs into `public` as thin wrappers precisely so that `app`,
   where the membership predicates live, stays unreachable over HTTP. If you expose `app`,
   `app.is_org_member(uuid)` becomes callable by any signed-in user against any org id.
2. **Copy two values** from Settings, API: the project URL and the `anon` key. Settings,
   API, JWT Settings: copy the JWT secret. All three are consumed in step 3.
3. **Check pg_cron is scheduled.** `0009_maintenance.sql` schedules the reaper and the
   retention sweep only if the extension is available, and it does not fail when it is not.
   Confirm with `select jobname, schedule from cron.job;`. If it is empty, enable pg_cron
   under Database, Extensions and re-apply `0009`. Without it, an expired lease is never
   reaped and a job that a crashed box was holding stays `leased` forever.

---

## 2. R2

The bucket and its lifecycle rules, from `workers/dl/infra/`:

```
export CLOUDFLARE_ACCOUNT_ID=67cb2eb6080019612e374af596f7197c
export CLOUDFLARE_API_TOKEN=...      # needs Workers R2 Storage:Edit
bash workers/dl/infra/r2-setup.sh
```

It is idempotent, and it reads the rules back and prints them, which is worth actually
reading: the lifecycle payload shape is the one part of the delivery design that was never
verified against a live API.

The five rules key off the retention class in the object prefix, `a/d7/`, `a/d30/` and so
on, because an R2 lifecycle rule can filter on a prefix and nothing else. That is also why
the render worker has to know `artifact_retention_days` before it uploads, and why
`lease_next_job` returns it.

Also create the preview bucket, which `wrangler dev` binds:

```
npx wrangler r2 bucket create kaviri-artifacts-preview
```

---

## 3. The api Worker

```
cd workers/api
npm install
npx tsc --noEmit && npx vitest run
```

Create the resources whose ids `wrangler.toml` currently has placeholders for:

```
npx wrangler kv namespace create CACHE
npx wrangler kv namespace create CACHE --preview
npx wrangler queues create kaviri-renders
```

Put the two ids into `workers/api/wrangler.toml` as `id` and `preview_id`. This is the one
edit to a tracked file the deploy requires.

Generate the artifact link signing key. It must be the same value in this Worker and the
dl Worker, so generate it once here and reuse it in step 4:

```
openssl rand -base64 48
```

Set the secrets. Each command prompts and reads from stdin, so the value never becomes a
shell history entry:

```
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_JWT_SECRET
npx wrangler secret put DL_SIGNING_KEY
npx wrangler deploy
```

`api.kaviri.dev` is declared as a custom domain, so wrangler creates the DNS record and
the certificate. It does not create the WAF configuration.

### By hand in the Cloudflare dashboard

`workers/api/README.md` has the five exact settings. In short, for `api.kaviri.dev`:

1. A **WAF skip rule, ordered first** in the phase that covers managed rules, rate
   limiting, Super Bot Fight Mode and Browser Integrity Check. A CI runner posting JSON on
   a schedule is indistinguishable from a bot to every one of those, because it is one.
2. **No Under Attack mode**, ever, on this hostname. It answers with a JavaScript
   challenge, and a GitHub Action cannot solve one: the failure looks like the API
   returning HTML where JSON was promised.
3. **No Cloudflare Access policy.** Access in front of an API means every caller gets a
   login page instead of a 401.
4. **WAF rate limiting off** for this hostname. The Durable Object token bucket is the
   limiter, and two limiters disagreeing produces a 429 with no `Retry-After`.

The README's two-line curl assertion catches a regression in any of these, and belongs in
the post-deploy smoke test rather than in somebody's memory.

---

## 4. The dl Worker

```
cd workers/dl
npm install
npx tsc --noEmit && npx vitest run
npx wrangler secret put DL_SIGNING_KEY     # the SAME value as step 3
npx wrangler deploy
```

If the two values differ, every artifact link the API mints is a 403 from the download
host, and nothing in either Worker's logs says why, because from dl's point of view a
link signed with the wrong key and a forged link are the same event. `workers/api`'s test
suite has a case for exactly this mismatch.

`DL_SIGNING_KEY_PREVIOUS` is set only during a rotation: deploy the new key as current and
the old one as previous, wait out the longest TTL in circulation, then remove it.

---

## 5. The render fleet

One Hetzner box at launch. There is a `RenderBackend` trait so Fly Machines can be added
when it needs to be elastic, but nothing about the launch path is elastic and nothing
pretends to be.

Deliberately not Modal. The owner's Modal account was disabled by a spend cap, and a
render fleet that goes dark on a billing event is not a fleet.

On the box, as root:

```
# 1. The egress fence. This is the control that actually holds.
./docker/egress.sh

# 2. The image. Pins are resolved once and then required.
./docker/resolve-pins.sh > docker/pins.env
REQUIRE_PINS=1 ./docker/build.sh

# 3. The worker itself
cargo build --release
install -m 0755 target/release/kaviri-render-worker /usr/local/bin/
install -m 0644 docker/kaviri-render-worker.service /etc/systemd/system/
```

`egress.sh` is not optional and is not a convenience. It creates a dedicated
`172.31.240.0/24` bridge with inter-container communication off and a `KAVIRI-EGRESS`
chain rejecting the private ranges, jumped to from `DOCKER-USER` **and** from `INPUT`,
because container-to-host traffic is delivered locally and never traverses `DOCKER-USER`.
The Chromium `--host-resolver-rules` flag is a second layer and is explicitly *not* the
control: Chromium does not consult its resolver for a URL that already contains an IP
literal, so `http://169.254.169.254/` never passes through it.

Configuration goes in `/etc/kaviri/worker.env`, mode `0600`, owned by the service user.
Every variable is listed in `.env.example` and explained in `render-worker/README.md`. The
worker's credential is a JWT whose role claim is `kaviri_worker`, which can execute three
functions and read no table at all. There is no service role key on this box, and adding
one would undo the reason the three functions exist.

Before starting it:

```
kaviri-render-worker doctor
```

`doctor` checks the image is present, the docker network exists, the work root is absolute
and writable, there is enough free space, and whether Chromium's user namespace sandbox is
available on this kernel. It reports the sandbox honestly rather than silently falling
back.

Then:

```
systemctl enable --now kaviri-render-worker
```

### The one thing the fleet still owes the API

`/v1/health` reads its queue depth from the KV key `health:queue` and reports `null` when
nothing has published it. Counting the queue at the edge would need a credential that
dissolves RLS, and holding one of those at the edge is the thing the schema exists to
prevent, so a null is the honest answer. A supervisor on this box should publish
`{"queued": n, "running": n}` to that key. Until it does, health reports a null depth,
which is correct and not a bug.

---

## 6. The playground

Static, so it is a Pages or static-assets deploy of `playground/` at `play.kaviri.dev`.

`playground/_headers` carries the CSP. Two lines in it are deployment-specific and a
self-hosted copy on a different base has to edit both: `connect-src` pins the API origin,
and `media-src` pins the download origin. Point either at the wrong host and the symptom
is a take that renders and then silently refuses to play.

The api Worker already sends the CORS the page needs, including
`Access-Control-Expose-Headers` for `X-Kaviri-Request-Id`, `Retry-After` and the three
`X-RateLimit-*` headers. Without those exposed the page cannot honour `Retry-After` and
earns its own 429.

---

## 7. Billing, which is optional and separate

The open service runs unmetered without any of this. `BILLING_MODE=none` is the default,
it is what CI tests, and the `clean-checkout` job exists to keep that true.

From `kaviri-billing`, against the **cloud** database, as the administrative role:

```
npm run seam:apply     # creates the kaviri_billing role and its exact grants
npm run seam:check     # asserts the privilege list exactly: an extra grant fails too
npm run migrate        # billing's OWN database, where the Stripe ids live
```

Two things worth knowing, both established against the live project rather than assumed:

- **`BYPASSRLS` does work on Supabase.** The `postgres` role is not a superuser, but it
  does hold `BYPASSRLS` and `CREATEROLE`, which is enough to pass the attribute on. The
  guard in `seam/0001_billing_role.sql` raises rather than half-applying if that ever
  stops being true, which matters because without the attribute every read returns zero
  rows silently rather than failing.
- **`seam:apply` must be re-run after any `reset.sh`.** Resetting drops the `public`
  schema, and billing's grants are on tables in it. `seam:check` is how you find out.

`PRICING-TBD.md` has seven open decisions. Nothing is purchasable until the Stripe price
mapping is set in the environment, which is deliberate: there are no prices in either
repository, and the private one reads them at runtime.

---

## 8. Before calling it live

```
./scripts/check-seam.sh        # the repository has no billing surface
./scripts/verify-seam.sh       # the applied schema has no billing surface either
```

Then the end to end path, which is the only test that covers all four components at once:
submit a take with a real key, poll it to `done`, follow the artifact link, and confirm
the object comes back with a `content-type` of `video/mp4` and plays.

A green CI run does not cover this, because CI has no fleet.

---

## Still outstanding

Honest list, rather than discovering these at the worst moment.

1. **No `LICENSE` file.** The repository is FSL 1.1 and the canonical text has to come
   from fsl.software. It is deliberately absent rather than reproduced from memory, since
   a subtly wrong licence is worse than a missing one. Add it before the repo goes public.
2. **Nothing deletes objects yet.** `expire_due_artifacts` returns storage keys for a
   sweeper that does not exist. The R2 lifecycle rules reclaim storage on their own, which
   is why they were built as the backstop rather than a convenience, so this is a cost
   question and not a correctness one. The sweeper needs a database credential, so it
   belongs on the render box or in a scheduled Worker, never in `dl`, which is the only
   unauthenticated surface in the system.
3. **An org with any usage cannot be hard-deleted.** `usage_events` cascades from `orgs`
   and has an append-only trigger that refuses every DELETE, so the cascade raises. This is
   arguably correct, since a ledger should outlive an accidental delete, but the
   `on delete cascade` is then misleading. Production must delete orgs by setting
   `orgs.deleted_at`.
4. **No forced HTTP proxy with a per-script domain allowlist.** Named in the egress design
   as the third layer and not built. The two layers that exist are the iptables fence and
   one-job-per-container.
5. **A caret pan bug in the recorder**, written up in `playground/NEEDS-FROM-RECORDER.md`
   section 6: a selectorless `type` op has no bbox, so the camera pans along the top edge
   of the viewport instead of along the field. `CARET_JS` already returns the line height
   that would fix it.
