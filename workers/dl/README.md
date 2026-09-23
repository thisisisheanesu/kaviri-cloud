# kaviri-dl

Artifact delivery. One Worker, one bucket binding, one HMAC secret, no database.

`api.kaviri.dev` decides who may have a take. This service only checks that somebody was
told they may, and then moves bytes.

## Why R2 and not the database's own storage

The product is a demo video you embed, and an embed in a README is fetched through
GitHub's camo proxy on every page view, by every visitor and every crawler, with no
session to attribute it to and no referrer to rate limit against. That is unbounded egress
against an object that never changes.

R2 charges nothing for egress. The bill for a take that gets popular is storage and class B
operations, both bounded, both ours to control. Every other candidate bills the one line
item with no ceiling, and the owner of this project has already had a compute account
disabled by a spend cap once. A demo video that is a build artifact cannot have a build
step that goes dark on a billing event.

## The URL

```
https://dl.kaviri.dev/1/lvz3k8/8Qk1u...43 chars.../a/d30/<org>/<job>/video.mp4
                     │  │       │                  └─ the R2 object key
                     │  │       └─ HMAC-SHA256, base64url
                     │  └─ expiry, unix seconds in base36
                     └─ signature scheme version
```

The signature is in the **path**, not in a query string. Three reasons, in the order they
cost you when you get them wrong:

1. **Caches key on the path reliably and on the query less so.** Cloudflare can be
   configured to ignore query strings, some corporate proxies strip them, and camo rewrites
   the URL it fetches. A credential that can be dropped in transit produces intermittent
   403s that nobody can reproduce.
2. **It survives being pasted.** One string, no reserved characters to escape, the same in
   a README, a Slack message and a YAML file.
3. **It lets the cache be shared.** Every link to one object is a different string, because
   each carries its own expiry. If the cache were keyed on the request URL, every fresh
   link would be a cold miss. This Worker verifies first and then looks the object up under
   a canonical key, `https://dl.kaviri.dev/__object/<key>`, so one cached copy serves every
   link. That is safe precisely because verification happens before the lookup.

The signed message is `kaviri-dl/1`, the expiry segment exactly as it appears, and the
decoded object key, newline separated. Signing the expiry as text rather than as a number
means a re-spelled expiry is a different message, so every link has exactly one valid form.

**Minting is done by the api Worker**, which imports `src/sign.ts` from here:

```ts
import { mintSignedUrl } from "../dl/src/sign";

const { url, expiresAt } = await mintSignedUrl(env.DL_ORIGIN, {
  key: artifact.storage_key,
  ttlSeconds: 300,
  maxTtlSeconds: secondsUntil(artifact.expires_at),
  secret: env.DL_SIGNING_KEY,
});
```

`maxTtlSeconds` is how a link is kept from outliving the artifact it points at. Pass the
remaining retention and a five minute link stays five minutes, while a link minted on the
last day of retention expires with the object rather than after it.

### Rotating the signing key

`DL_SIGNING_KEY` signs and verifies. `DL_SIGNING_KEY_PREVIOUS` only verifies. To rotate:
set the new secret as current and the old one as previous, wait out the longest TTL in
circulation, then remove previous. Links already pasted into READMEs keep working
throughout.

## Range requests

Safari's first request for a `<video>` source is `Range: bytes=0-1`. A server that answers
that with 200 and the whole file is treated as not seekable, and the element loads and then
refuses to play. Byte ranges here are not an optimisation, they are whether the demo works
on iOS.

Supported: `bytes=0-1`, `bytes=500-`, `bytes=-200`, an end clamped past the object, and 416
with `Content-Range: bytes */<size>` for a range outside it. Multiple ranges in one request
are answered with the whole object, which RFC 9110 permits and which no media element asks
for anyway. `If-Range` is not implemented: objects are immutable per key, so the case it
guards against does not arise.

`Accept-Ranges: bytes` goes on every response including the 200, because a player decides
whether a source is seekable from the first response it sees.

## Caching

| layer | lifetime | why |
|---|---|---|
| browser | the remaining life of the signature, capped at a year, `immutable` | a cached copy must not outlive the link that fetched it. A five minute link leaving a year long copy in a shared proxy is a credential with the wrong lifetime. |
| Cloudflare edge | `DL_EDGE_CACHE_SECONDS`, one hour by default | an hour is short enough to describe honestly when a customer asks why a take they expected to be gone played once more after the sweep deleted it. |

Objects larger than `DL_CACHE_MAX_BYTES` (64 MiB) are streamed straight through and never
stored, so one large take cannot evict everything else or stall behind a slow client while
the cache write tees. Ranged responses are never cached, because a 206 cannot be put into
the Cache API at all. `X-Kaviri-Cache` on the response says `hit`, `miss` or `bypass`.

A takedown is a Cloudflare purge by URL of `https://dl.kaviri.dev/__object/<key>`, which is
why the cache key is a real URL under this hostname rather than a synthetic one.

## Responses

| status | when |
|---|---|
| 200 | the whole object |
| 206 | a satisfied range |
| 304 | `If-None-Match` matched the object's ETag |
| 403 `link_invalid` | anything wrong with the signature, the version or the key |
| 403 `link_expired` | the signature was good and the expiry has passed |
| 404 `not_found` | the signature was good and there is no such object |
| 405 | anything but GET, HEAD or OPTIONS |
| 416 | a range outside the object |
| 500 | the signing key is not configured, or the read failed |

Every failure except an expiry is one status and one code, with `detail.reason` naming what
was wrong with the shape of the URL. The expiry is kept separate only because the signature
has already been proved good by the time it is checked, so the difference between "wrong"
and "too late" cannot be used to learn whether a guessed key exists.

A missing object is 404 here rather than the 410 `gone` the API returns, because this
Worker has no row and cannot tell retention from a failed upload. Use
`GET /v1/jobs/{id}/artifact` for the answer that knows the difference.

Errors use the envelope from `docs/API.md`, including `X-Kaviri-Request-Id`, so a customer
does not have to learn a second error shape because different bytes came from a different
Worker.

## What is served as what

Content types are on an allow list: `video/mp4`, `video/webm`, `image/png`, `image/jpeg`,
`image/webp`, `image/avif`, `application/json`, `text/plain`. Anything else is served as
`application/octet-stream` with `Content-Disposition: attachment`.

The allow list exists because `artifacts.content_type` is whatever the render worker wrote,
and a public host that reflects an arbitrary content type is one compromised render box
away from serving `text/html` from a domain we control. Every response also carries
`Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options:
nosniff`, so the worst case is a blank page rather than script on our origin.

## The bucket

### Layout

```
a/<retention class>/<org id>/<job id>/<kind>.<ext>
```

One object per `(job, kind)`, matching the unique constraint on `public.artifacts`, so a
retry that re-renders a take overwrites its predecessor instead of leaving an object behind
that no row points at and no customer can delete. `src/keys.ts` is the single definition:
the render worker builds keys with `artifactKey()`, the sweeper reads them with
`parseArtifactKey()`.

The org and job ids are in the key because a bucket listing is the last resort when
something has gone wrong, and a listing of opaque hashes helps nobody. Neither is a secret.
The signature authorises the fetch, not the difficulty of guessing the path.

### Retention classes, and why they are in the key

R2 lifecycle rules filter on a key prefix and nothing else. No per-object expiry header, no
tags, no way to consult a database. So the only way the bucket itself can guarantee that a
short-retention take does not sit there for a year is to put the class in the prefix and
write one rule per class.

| class | `artifact_retention_days` | lifecycle rule |
|---|---|---|
| `a/d7/` | 1 to 7 | delete at 8 days |
| `a/d30/` | 8 to 30, and the default | delete at 31 days |
| `a/d90/` | 31 to 90 | delete at 91 days |
| `a/d365/` | 91 to 365 | delete at 366 days |
| `a/keep/` | null, meaning unlimited | none |

Each rule waits one day longer than the class. **Postgres is authoritative**:
`expire_due_artifacts` marks the row and a sweeper deletes the object, and the extra day
keeps the bucket from removing an object while a customer's still-valid link points at it.

The lifecycle rules are the backstop, and they matter more than they look. The sweeper can
only delete objects it has a row for. The objects that actually run a storage bill up are
the ones with no row at all: an upload that finished a moment before the render box died, a
retry whose `complete_job` never landed, an abandoned multipart. Nothing in the database
knows those exist. The rules do not care, because they act on the prefix. There is also a
rule aborting incomplete multipart uploads after a day, which is the exact leak
`docs/LIFECYCLE.md` names when it explains why a cancel is not a kill.

The class is stamped at upload time from the org's effective `artifact_retention_days`. An
org whose retention grows later keeps the old class on takes already filmed. That is a
deliberate simplification: the alternative is copying objects between prefixes on every
change, and a copy that half fails leaves an artifact in two classes or in none.

### Setting it up

```sh
export CLOUDFLARE_API_TOKEN=...   # Workers R2 Storage:Edit, this shell only
bash infra/r2-setup.sh
```

It creates `kaviri-artifacts` with the `weur` location hint, to sit next to the Supabase
project in `eu-central-1`, and replaces the lifecycle rule set with `infra/r2-lifecycle.json`.
Both steps are idempotent.

A location hint and not a jurisdiction: a jurisdiction is fixed at creation, changes the S3
endpoint and makes every later wrangler call need a flag. Nothing here has a data residency
obligation that would pay for that. If one ever appears, the bucket has to be recreated.

### What has to be done in the Cloudflare dashboard

None of this can be set from code, and all of it is load bearing:

1. **Public access must stay disabled.** The bucket's Settings, Public Development URL:
   leave `r2.dev` off, and attach no public custom domain to the bucket. A publicly
   readable bucket makes every signature in this Worker decorative. This is the single
   most important manual step.
2. **The `kaviri.dev` zone must be on this account** before `wrangler deploy` can claim
   `dl.kaviri.dev` through the `custom_domain` route in `wrangler.toml`.
3. **The API token** used by `infra/r2-setup.sh` is created under My Profile, API Tokens,
   with Workers R2 Storage:Edit on this account. It is not stored anywhere in this
   repository.
4. **Cache Reserve, if it is ever turned on**, applies to this zone. It is not needed:
   R2 reads are cheap and the edge cache above is doing the work.
5. **Verify the lifecycle rules landed**, in the bucket's Settings under Object lifecycle
   rules. The rule format is the one part of this that has changed under us before, and a
   rule that is silently rejected expires nothing. `infra/r2-setup.sh` prints back what the
   bucket says at the end for exactly this reason.

## Where this meets the rest of the service

- **The api Worker** mints links with `src/sign.ts` and builds keys with nothing: the keys
  come from `artifacts.storage_key`, which the render worker wrote.
- **The render worker** builds keys with `src/keys.ts` and passes the same string to
  `complete_job` as `storage_key`. Upload first, then complete, as
  `supabase/migrations/0008_worker_functions.sql` says: a row pointing at an object that
  does not exist is a 404 on a customer's link, whereas an object with no row is the
  lifecycle rules' problem and they are already handling it.
- **The object sweeper**, whatever runs `expire_due_artifacts` and deletes the keys it
  returns, does not live here and must not. It needs a database credential, and this is the
  one public, unauthenticated Worker in the system, so it is the one worth keeping empty of
  credentials. Until that sweeper exists, the lifecycle rules above are what actually
  reclaims storage, and they are sufficient on their own.
- **`docs/API.md` sketches the artifact redirect** as a query-signed URL on an `r2.` host.
  This Worker signs in the path on `dl.kaviri.dev` instead, for the reasons at the top of
  this file. The API contract that matters is unchanged: `GET /v1/jobs/{id}/artifact`
  returns `302` with a `Location`, or the URL in a body with `?redirect=false`. Only the
  shape of the URL behind it differs, and the example in `docs/API.md` should be updated to
  match.

## Secrets

Set with `wrangler secret put`, read from the environment at runtime, never written to a
file:

| name | where |
|---|---|
| `DL_SIGNING_KEY` | this Worker and the api Worker. The same value in both, or every link 403s. |
| `DL_SIGNING_KEY_PREVIOUS` | this Worker, during a rotation only |

Generate one with `openssl rand -base64 48`.

## Developing

```sh
npm install
npm test          # vitest, plain Node, no workerd needed
npm run typecheck
npx wrangler dev
```

The tests run against a stub bucket in plain Node, because every module here is written
against web standards Node has had since 18. The bucket is the only Cloudflare-specific
thing the Worker touches and it is reached through a five line interface. That is worth
more than the fidelity of running inside workerd, because it means the Range and signature
edge cases are tested on every commit instead of being checked by hand against a deployed
URL.
