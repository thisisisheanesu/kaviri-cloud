# kaviri-api

The edge Worker behind `api.kaviri.dev`. It implements `docs/API.md` and nothing else.

It writes a row, nudges a queue and gets out of the way. It does not render: a Worker
cannot run Chromium, so the video is made on the fleet and this Worker never sees a frame.

```
GitHub Action ──► api.kaviri.dev ──► submit_job ──► render_jobs  ◄── the fleet leases
                       │                                              and uploads
                       ├──► Cloudflare Queues, a nudge
                       └──► a signed R2 URL, five minutes, minted per request
```

## What is here

| file | what it is |
|---|---|
| `src/index.ts` | the router, and the one place an error becomes a response |
| `src/auth.ts` | API key resolution with a KV cache, and the short-lived org token |
| `src/jwt.ts` | HS256 minting. No service role key exists on this path |
| `src/pg.ts` | the PostgREST client, and Postgres errcode to HTTP status |
| `src/validate.ts` | script and options validation, pure, the recorder's rules |
| `src/entitlements.ts` | limits, read only through `app.effective_entitlements` |
| `src/bucket.ts` | the token bucket as arithmetic, so it can be tested |
| `src/do/token-bucket.ts` | the Durable Object that stores one bucket per org |
| `src/shape.ts` | eight database states to six API states, and the job body |
| `src/r2.ts` | SigV4 query signing for artifact downloads |
| `src/routes/` | the endpoints |

## The four things that keep the pages from being hammered

**API key auth, hashed, cached in KV.** A presented key is SHA-256ed and looked up in KV
before Postgres is asked anything. The cached value is the org and the key row id, which
is all a request needs. The cache key is the same digest the database stores, so a dump of
the cache is worth no more than a dump of `api_keys`. A key that does not resolve is
cached too, for thirty seconds: well formed but unknown keys arriving in bulk would
otherwise be one database round trip each, which is a denial of service with no skill in
it. Revocation takes effect within `KEY_CACHE_TTL_SECONDS`, sixty by default.

**A Durable Object token bucket per org.** One object per `(org, bucket)` pair. A
Durable Object and not KV, because a limit read and written from three colos at once has
to serialise somewhere, and an eventually consistent limit gives a burst three full
budgets. Submission and polling are separate buckets: a CI job polling every two seconds
must not spend its own ability to submit the next take. If the limiter is unreachable the
Worker fails open and logs it, because the thing behind the limiter, `submit_job`, is what
enforces the limits that actually matter.

**Idempotency keys.** KV first, the database second, `submit_job` third. A replayed key
with the same script returns `200` and the original job. A replayed key with a different
script or different options is `409 idempotency_conflict`; the service does not quietly
hand back a job that renders something else. The fingerprint is a SHA-256 over canonical
JSON of the script and the resolved options, so a retry from a client that reserialised
the body still matches. `source` is deliberately not in the fingerprint: a re-run carries
a different run id while filming exactly the same thing.

**Request size limits.** `Content-Length` is checked before the body is read, and the byte
count again after, because a chunked request declares nothing. Over the limit is `413`.

## Errors are always JSON

Every response this Worker can produce goes through `jsonResponse`, including the
catch-all in `fetch`. There is no path that returns HTML.

That solves half the problem. The other half is in front of the Worker, and it is the one
that costs a day to debug when it happens.

### The WAF skip rules the api subdomain must have

If bot protection, a managed WAF rule or a challenge ever answers a request to
`api.kaviri.dev`, the caller gets an HTML interstitial with a `200` on it. A GitHub Action
parsing that reports:

```
expected JSON, got <!DOCTYPE html>
```

and nobody can debug it, because the Worker never ran and there is nothing in its logs. A
machine caller cannot solve a challenge, so every challenged request is a permanently
failed build.

Configure the following on the zone, for the hostname `api.kaviri.dev`:

1. **A WAF custom rule, action Skip, first in the list.**
   Expression: `(http.host eq "api.kaviri.dev")`
   Skip: All remaining custom rules, Managed rules, Rate limiting rules, Super Bot Fight
   Mode, Browser Integrity Check.
   Order: it must be the first rule in the phase. A rule below a challenge does not
   un-challenge anything.

2. **Bot Fight Mode off for the zone, or the skip above must include it.** Super Bot Fight
   Mode classifies a `curl` and a GitHub Actions runner as automated, which they are. This
   API is for automated callers.

3. **No Under Attack mode on this hostname.** It is a zone-wide setting and it challenges
   everything. If the zone needs it, `api.kaviri.dev` needs a Configuration Rule that
   turns Security Level down to Essentially Off for that hostname.

4. **No Access policy on the hostname.** Cloudflare Access answers with a redirect to a
   login page, which an Action follows into HTML.

5. **Rate limiting is the Worker's job, not the WAF's.** A WAF rate limit returns an HTML
   429 with no `Retry-After` a client can use, and it is per IP, which for a hosted CI
   runner is a shared IP. Skip the WAF rules and let the Durable Object do it, which is
   per org and returns the documented JSON body.

After a change, the check that matters:

```sh
curl -sS -i https://api.kaviri.dev/v1/health | head -1
curl -sS https://api.kaviri.dev/v1/health | head -c 1
```

The second command must print `{`. If it prints `<`, one of the five above is wrong.

It is worth putting that exact assertion in the smoke test that runs after every deploy,
because a WAF rule can be added by somebody who never sees this file.

## What this Worker needs from the schema

`app.verify_api_key` and `app.effective_entitlements` live in the `app` schema, which
migration `0001_foundation.sql` describes as deliberately unexposed to PostgREST. The edge
has to reach both: resolving a key is how a request gets an org at all, and reading
entitlements anywhere other than `app.effective_entitlements` would miss the platform
ceilings, which the schema calls a bug in so many words.

Two ways to satisfy that, and the Worker does not care which:

- Add `app` to the project's exposed schemas and leave `APP_RPC_SCHEMA = "app"`. The
  Worker sends `Accept-Profile` and `Content-Profile`, so only the functions that have an
  explicit `grant execute` are reachable, and no table in `app` is selectable.
- Or add thin `public` wrappers named `verify_api_key` and `effective_entitlements` with
  the same arguments, and set `APP_RPC_SCHEMA = "public"`.

The second is the smaller surface. Either way it is a decision for whoever owns
`supabase/migrations/`, and this Worker was not going to edit someone else's directory to
make it.

## Two additions to the error table in docs/API.md

Both should be added there. They are used because the alternative was mislabelling.

| code | status | when |
|---|---|---|
| `request_too_large` | 413 | the body, or `source`, is over the configured limit |
| `job_not_ready` | 409 | the artifact endpoint was called on a job that is still queued or running. `detail.status` says where it is |
| `org_ambiguous` | 400 | a human caller is a member of several orgs and named none. Machine callers cannot hit this: a key belongs to one org |

## Queue depth in /v1/health

`queue.queued` and `queue.running` are read from the KV key `health:queue`, published by
the fleet supervisor, and are `null` when nothing has published them. This Worker cannot
count the queue itself: that means reading every tenant's rows, which needs a credential
that dissolves Row Level Security, and holding one of those at the edge is exactly what
the schema was built to avoid. A null is honest. A zero would be read as a fact.

Publish it from the supervisor as:

```json
{ "queued": 12, "running": 3 }
```

## Human callers and the org header

A machine caller's key belongs to exactly one org, so there is nothing to choose. A human
presenting a Supabase session JWT may be in several, and picks one with:

```
X-Kaviri-Org: 22222222-2222-4222-a222-222222222222
```

With no header and exactly one membership, that one is used. With no header and several,
the answer is `400 org_ambiguous`, because guessing means filing a take against the wrong
customer.

## Configuration

Set with `wrangler secret put`, never written to a file:

```
SUPABASE_URL  SUPABASE_ANON_KEY  SUPABASE_JWT_SECRET
R2_ACCOUNT_ID  R2_ACCESS_KEY_ID  R2_SECRET_ACCESS_KEY
```

The rest is in `wrangler.toml` and is tunable without a code change:
`RATE_SUBMIT_PER_MIN`, `RATE_POLL_PER_MIN`, `MAX_BODY_BYTES`, `MAX_SOURCE_BYTES`,
`KEY_CACHE_TTL_SECONDS`, `ENTITLEMENTS_CACHE_TTL_SECONDS`,
`IDEMPOTENCY_CACHE_TTL_SECONDS`, `SIGNED_URL_TTL_SECONDS`, `R2_BUCKET`, `R2_PUBLIC_HOST`,
`APP_RPC_SCHEMA`, `SERVICE_VERSION`.

Before the first deploy, create the KV namespace and the queue and put their ids in
`wrangler.toml`:

```sh
wrangler kv namespace create CACHE
wrangler queues create kaviri-renders
```

## Running it

```sh
npm install
npm run typecheck
npm test
npm run dev
npm run deploy
```

The tests are plain Vitest against Node's Web Crypto, which is the same surface the
runtime provides. Pure functions are tested directly; the router is driven through fakes
for KV, the Durable Object, the queue and PostgREST, and asserts the behaviour the Action
depends on, starting with the fact that no response is ever anything but JSON.
