# kaviri-cloud

The hosted half of [kaviri](https://github.com/vamboai/kaviri). You POST a script, you get
an MP4.

This repository holds the database, the edge Workers, the render worker and the
playground. It is licensed FSL 1.1, which converts to Apache 2.0 on schedule. It contains
no billing logic and no prices, and there is a CI job that keeps that true.

The recorder itself stays Apache 2.0, unconditional, and free forever for local and self
hosted use, with no account and no network call to us. The hosted service is the
convenience on top: a queue, storage, a URL you can link, and concurrency.

## The three repositories

| repository | licence | what is in it |
|---|---|---|
| `kaviri` | Apache 2.0 | the recorder, the GitHub Action, the wasm planner |
| `kaviri-cloud` | FSL 1.1 | this repo: Supabase, Workers, the render worker, the playground |
| `kaviri-billing` | proprietary, private | Stripe, plans, invoicing, admin |

## The seam

The split is only worth anything if it is real. Three rules, each of them checkable:

**The open repository contains no billing logic and no prices.** Not in code, not in the
schema, not in a constant somewhere. `scripts/check-seam.sh` strips comments and string
literals from every SQL and TypeScript file and fails the build on an identifier that is
about money. Comments and documentation are exempt, because explaining why the seam
exists requires writing the words, and a check that forbade the words would be satisfied
by deleting the explanation.

**Billing writes exactly one table: `org_entitlements`.** It holds what a tenant is
allowed to do, never what a tenant pays. No amount, no currency, no interval, no Stripe
identifier, no invoice, no discount. The rule that keeps it honest: if deleting the
billing service entirely would make a column meaningless, the column is in the wrong
repository. `max_concurrent_renders` survives that deletion. `seat_price_cents` does not.

A null limit means unlimited, which makes the unmetered default the absence of a
constraint rather than a very large number that some comparison will one day forget to
special case.

**Billing reads exactly one view: `v_org_usage_month`.** Quantities and a plan label per
org per month. It is a view rather than table access so that the shape billing depends on
is declared here, in the open, and cannot widen by accident.

### BILLING_MODE=none

The open repository builds and runs end to end with `BILLING_MODE=none`, granting every
tenant unmetered, with no access to `kaviri-billing`. The `clean-checkout` job in
`.github/workflows/ci.yml` proves it on every commit: a default checkout with no
submodules and no second repository, a clean Postgres, every migration applied in order,
and `supabase/tests/seam_none.sql` asserting that a fresh org is unmetered, that the
lifecycle runs from submit to artifact, and that one tenant cannot read, write or count
another's rows.

Platform ceilings still apply in that mode, because they are the limits of the machine
rather than of a plan: 1800 seconds per job, 2000 ops per script, 8 concurrent renders.
A take spooling at roughly 15 to 25 MB per second cannot be allowed to run for an hour on
a shared box no matter who is paying.

## What is here

```
supabase/migrations/   the schema, in order. Runnable against a real Supabase project.
supabase/shim/         just enough Supabase to apply the migrations to a plain Postgres,
                       so CI can prove the clean-checkout claim without an account.
supabase/tests/        the end to end proof, in SQL.
docs/API.md            the HTTP contract. Everything codes against this document.
docs/LIFECYCLE.md      the job state machine, leasing, reaping, retries and retention.
scripts/check-seam.sh  the seam check, run in CI.
```

## Architecture

```
  GitHub Action  ─┐
  playground     ─┼─► Cloudflare Worker ──► Supabase Postgres ◄── render worker
  your own script ┘      api.kaviri.dev          (the queue)      (Hetzner, one box)
                              │                                        │
                              └──► R2, artifacts ◄─────────────────────┘
```

**The queue is the database.** `lease_next_job` hands out one job per call using
`FOR UPDATE SKIP LOCKED`, so two workers polling at the same instant take two different
jobs. There is no separate queue service to keep in sync with the rows that describe the
work.

**The fleet has three functions and no table privileges.** The render worker connects
with a JWT whose role is `kaviri_worker`. That role can execute `lease_next_job`,
`report_progress` and `complete_job`, and can select nothing, insert nothing and update
nothing. Within those three, authority is per job: the lease token minted at lease time
is the worker's only claim on the job, and a worker that stalled and lost its lease
cannot overwrite the result of the worker that replaced it. No component of this system
holds a service role key on a machine that runs customer scripts.

**One Hetzner box at launch, behind a `RenderBackend` trait.** Not Modal. The owner's
Modal account was disabled by a spend cap in August, which is the render fleet going dark
on a billing event, and a demo video that is a build artifact cannot have a build step
that does that. Fly Machines can be added behind the same trait the day elasticity is
worth more than predictability.

**Artifacts are rows pointing at R2 objects, never stored URLs.** A signed URL has an
expiry and belongs to one request, so storing one would be handing out a credential with
the lifetime of a database row. The API mints one per GET, valid for five minutes.

## Isolation

Row Level Security is on and forced on every tenant table. A member of org A cannot read,
write or count rows of org B, and the select policies are what bounds `count(*)`, so the
answer to "how many jobs does that other org have" is zero rather than an error: the
existence of another tenant's data is itself not disclosed.

There is one membership predicate, `app.is_org_member`, and every policy is written
against it. A human is a member when a row in `org_members` says so. A machine caller,
holding an API key, is a member of exactly the one org the key was issued for and of no
other. Administrative actions need `app.is_org_admin`, which a machine caller never
satisfies, so a leaked key can submit takes but cannot mint more keys or add a member.

API keys are stored as a SHA-256 of the presented string plus a `kv_` prefix for display.
There is no path that reads a key back out, including for an admin of the org that owns
it: `key_hash` is excluded from the column-level select grant.

## Applying the schema

Against a Supabase project, in filename order:

```sh
supabase link --project-ref <ref>
supabase db push
```

Against a plain Postgres, for a local run or in CI:

```sh
psql -v ON_ERROR_STOP=1 -f supabase/shim/0000_supabase_shim.sql
for f in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
psql -v ON_ERROR_STOP=1 -f supabase/tests/seam_none.sql
```

The shim is never applied to a Supabase project, which already has all of it.

`pg_cron` schedules the reaper every minute and the retention sweep hourly. Where it is
unavailable the migration says so and the two functions are called from an external
scheduler instead. They are idempotent, so a missed run costs lateness and never
correctness.

## House style

No em dashes, anywhere: code, comments, copy, SQL, docs. Comments explain why, in full
sentences, and never restate what the line plainly does. No invented prices, no invented
metrics, no fake testimonials. Secrets are read from the environment at runtime and never
land in a file.

## Licence

FSL 1.1 with an Apache 2.0 future licence. Add the canonical text from fsl.software as
`LICENSE` before this repository goes public.
