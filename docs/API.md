# kaviri cloud HTTP API, v1

The contract between the edge Workers, the GitHub Action, the playground and anything
else a customer points at us. Everything in this repository codes against this document.

Base URL: `https://api.kaviri.dev`
All paths below are relative to it. There is no unversioned path.

The recorder is the source of truth for what a script may contain. This document
describes how a script is submitted, not what the ops mean; for that see
`kaviri/README.md`, section "Op protocol".

## Conventions

- Request and response bodies are `application/json; charset=utf-8`, except an artifact
  download, which is the bytes.
- Timestamps are RFC 3339 with a `Z` offset: `2026-09-23T11:04:02.481Z`.
- Durations are seconds, as JSON numbers, fractional where the source is fractional.
- Sizes are bytes, as JSON integers.
- Identifiers are UUIDv4 strings. A job id is the only id a normal caller needs.
- Unknown fields in a request body are rejected rather than ignored, so a typo in
  `presset` fails loudly in CI instead of silently rendering the default.
- Every response carries `X-Kaviri-Request-Id`. Quote it in a support request.

## Authentication

Two kinds of caller, one header.

```
Authorization: Bearer kv_7f3k4x2m_aG9sZFRoaXNJc0Fub3RoZXJSYW5kb21TZWNyZXQ
```

**Machine callers** present an API key. The key is `kv_`, an eight character lowercase
base32 prefix, an underscore, and a secret of at least 16 URL-safe characters. Only the
SHA-256 of the whole string is stored, so a lost key cannot be recovered and is replaced
rather than looked up. The prefix is what appears in the dashboard key list.

**Human callers** present a Supabase session JWT in the same header. The edge tells them
apart by shape, not by a second header.

The edge resolves a key to an org and then does the work under a short-lived Postgres JWT
carrying `kaviri_org`. The key itself never travels past the edge, and no component of
the system, including the render fleet, holds a service role key.

Missing or malformed credentials are `401`. A valid credential for the wrong org is
`404`, never `403`, so an endpoint cannot be used to probe which job ids exist in another
tenant.

## Errors

Every error is this shape, at every endpoint, including `401` and `500`.

```json
{
  "error": {
    "code": "script_invalid",
    "message": "op 4: wait takes ms or selector, never both",
    "detail": { "op_index": 4 },
    "request_id": "01JB5Q2W8N4T7M0Z9K3PXYVA6C",
    "docs": "https://kaviri.dev/docs/api#errors"
  }
}
```

`code` is stable and safe to branch on. `message` is for a human and may be reworded in
any release. `detail` is present when there is something structured to say and is
omitted, not null, when there is not.

| code | status | when |
|---|---|---|
| `unauthorized` | 401 | no credential, or one that does not parse |
| `key_revoked` | 401 | the key parsed, and has been revoked or has expired |
| `not_found` | 404 | no such job, project or artifact, for this caller |
| `gone` | 410 | the artifact existed and retention swept it |
| `script_invalid` | 422 | the script is not an array of valid ops |
| `options_invalid` | 422 | an unknown preset, background, or an out of range scale |
| `unknown_field` | 422 | a field the endpoint does not define |
| `idempotency_conflict` | 409 | the key was reused with a different script or options |
| `limit_exceeded` | 402 | a plan limit was reached; `detail.limit` names which |
| `rate_limited` | 429 | too many requests; honour `Retry-After` |
| `job_not_cancellable` | 409 | the job is already terminal |
| `job_not_ready` | 409 | the artifact was asked for while the job is still queued or running |
| `request_too_large` | 413 | the body, or `source`, is over its limit |
| `org_ambiguous` | 400 | a human caller belongs to several orgs and sent no `X-Kaviri-Org`. Unreachable for a machine caller, whose key names exactly one org. |
| `internal` | 500 | ours |
| `unavailable` | 503 | the queue is not accepting work; `Retry-After` is set |

`402` for a limit is deliberate, and it is the one place the open service touches the
subject of money at all: it reports that a limit was hit and names it. It never quotes a
price, an amount owed or an upgrade cost. A tenant limit exists only where something
wrote one into `org_entitlements`, so on a deployment with no billing service every tenant
limit is unset and a `402` can only come from a platform ceiling, with `detail.limit`
being `max_job_seconds`, `max_script_ops` or `max_concurrent_renders`.

## Rate limits

Per org, applied at the edge. Every response carries:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1758623045
```

A `429` also carries `Retry-After` in seconds. Submission and polling have separate
budgets, because a CI job that polls every two seconds must not use up its own ability to
submit.

---

## POST /v1/jobs

Submit a take. Returns immediately; the render happens on the fleet.

### Request

```json
{
  "project": "web",
  "script": [
    {"op": "navigate", "url": "https://kaviri.dev"},
    {"op": "click", "selector": "#get-started"},
    {"op": "type", "selector": "#email", "text": "ada@example.com"},
    {"op": "wait", "selector": ".welcome", "timeout_ms": 20000},
    {"op": "wait", "ms": 1500}
  ],
  "options": {
    "preset": "desktop",
    "background": "auto",
    "scale": 2,
    "out_width": null,
    "out_height": null
  },
  "source": {
    "repository": "thisisisheanesu/kaviri",
    "ref": "refs/pull/412/merge",
    "sha": "9f1c2ae",
    "run_id": "11224455"
  },
  "idempotency_key": "gha-11224455-1"
}
```

| field | type | required | notes |
|---|---|---|---|
| `project` | string | yes | slug, `[a-z0-9-]`, 1 to 40 characters. Created on first use. |
| `script` | array | yes | one op object per element, as the recorder defines them. At least 1, at most `max_script_ops` (2000 platform ceiling). |
| `options` | object | no | merged over the project's defaults. See below. |
| `source` | object | no | free form provenance, shown in the dashboard. At most 4 KiB. |
| `idempotency_key` | string | no | 8 to 200 characters. Scoped to the org. |

`options`:

| field | type | default | allowed |
|---|---|---|---|
| `preset` | string | `"desktop"` | `desktop`, `tiktok`, `reels`, `shorts`, `square`, `landscape`, `readme`, `phone` |
| `background` | string | `"auto"` | `auto`, `none`, `dusk`, `dawn`, `tide`, `moss`, `ember`, `slate`, `linen`, `mesh-cool`, `mesh-warm` |
| `scale` | number | preset's own | 0.5 to 4.0 |
| `out_width` | integer or null | preset's own | 64 to 8192 |
| `out_height` | integer or null | preset's own | 64 to 8192 |
| `cursor` | string | `"auto"` | `auto`, `none`, `arrow`, `hand`, `text` |
| `cursor_scale` | number | 1.75 | 0.2 to 8.0 |
| `telemetry` | boolean | `false` | when true, a `telemetry` artifact is produced alongside the video. It carries every `navigate` URL verbatim, including query strings, so it is off by default. |

### Script validation

The edge validates the script before the job is queued, because a script that fails on
op 4 should fail in under a second rather than after a box has been leased and Chromium
started. The rules are the recorder's, and the edge is not allowed to be more permissive
than it:

- Every element is an object with a string `op` in
  `navigate`, `click`, `type`, `scroll`, `wait`, `mark`, `start_recording`, `stop_recording`.
- `wait` takes `ms` or `selector`, never both.
- `scroll` requires a numeric `y`, an absolute document offset.
- `navigate` requires an absolute `http` or `https` `url`. The hosted service refuses
  `file://` and any non-routable host, which is the one place it is deliberately
  stricter than the self-hosted recorder: on a shared fleet, `file:///etc/passwd` and
  `http://169.254.169.254/` are not takes, they are exfiltration.
- Durations (`ms`, `timeout_ms`, `typewriter_ms`) are finite non-negative numbers.
- `start_recording` and `stop_recording` are accepted but unnecessary; the service wraps
  every script in them.

A violation is `422 script_invalid` with `detail.op_index` set to the offending element.

### Idempotency

A submission carrying `idempotency_key` that matches an earlier submission from the same
org returns the original job with `200` instead of creating a second one. A GitHub Action
whose response timed out can retry safely, and a re-run of the same workflow attempt does
not film the same commit twice.

Reusing a key with a different `script` or `options` is `409 idempotency_conflict`. The
service does not silently return a job that renders something else.

### Response, 202 Accepted

```json
{
  "id": "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
  "status": "queued",
  "project": "web",
  "created_at": "2026-09-23T11:04:02.481Z",
  "progress": 0,
  "attempt": 0,
  "max_attempts": 3,
  "script_sha256": "6b1f...c0",
  "options": { "preset": "desktop", "background": "auto", "scale": 2 },
  "artifacts": [],
  "links": {
    "self": "/v1/jobs/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
    "artifact": "/v1/jobs/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/artifact"
  }
}
```

`200 OK` with the same body when an idempotency key matched an existing job. The status
code is the only difference, and it is how a caller can tell.

| status | meaning |
|---|---|
| 202 | queued |
| 200 | already existed, idempotency key matched |
| 401 | `unauthorized`, `key_revoked` |
| 402 | `limit_exceeded` |
| 422 | `script_invalid`, `options_invalid`, `unknown_field` |
| 409 | `idempotency_conflict` |
| 429 | `rate_limited` |
| 503 | `unavailable` |

---

## GET /v1/jobs/{id}

Poll it. This is the endpoint a CI job sits on.

### Response, 200 OK

```json
{
  "id": "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
  "status": "running",
  "project": "web",
  "progress": 0.62,
  "message": "op 12 of 31: click #buy",
  "attempt": 1,
  "max_attempts": 3,
  "created_at": "2026-09-23T11:04:02.481Z",
  "started_at": "2026-09-23T11:04:09.115Z",
  "finished_at": null,
  "expires_at": null,
  "render_seconds": 0,
  "error": null,
  "artifacts": [],
  "links": {
    "self": "/v1/jobs/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
    "artifact": "/v1/jobs/4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44/artifact"
  }
}
```

`status` is one of `queued`, `running`, `done`, `failed`, `cancelled`, `expired`. The
database has eight states; the API has six. `leased` and `uploading` both report as
`running`, because from outside they mean the same thing: not ready yet. See
`docs/LIFECYCLE.md`.

While `queued`, the body also carries `"queue_position": 3` when it can be computed
cheaply, and the response carries `Retry-After: 5`. While `running`, `Retry-After: 2`.
A polite client honours it; an impolite one meets `429`.

When `done`:

```json
{
  "status": "done",
  "progress": 1,
  "finished_at": "2026-09-23T11:05:41.902Z",
  "expires_at": "2026-10-23T11:05:41.902Z",
  "render_seconds": 92.4,
  "artifacts": [
    {
      "kind": "video",
      "content_type": "video/mp4",
      "bytes": 8123456,
      "sha256": "3f9a...11",
      "duration_seconds": 21.4,
      "width": 1470,
      "height": 830,
      "url": "/v1/jobs/4a2c.../artifact?kind=video"
    }
  ]
}
```

When `failed`:

```json
{
  "status": "failed",
  "error": {
    "code": "op_failed",
    "message": "selector matched a non-visible element: #done",
    "detail": { "op_index": 7, "op": {"op": "click", "selector": "#done"} },
    "retryable": false
  },
  "artifacts": [
    { "kind": "video", "partial": true, "bytes": 2201984, "url": "/v1/jobs/4a2c.../artifact?kind=video" }
  ]
}
```

A failed job may still carry a video. The recorder stops the recording, renders what it
captured and exits non-zero when an op fails, so there is usually footage up to the
failure, and it is the fastest way to see what the page actually looked like. It is
flagged `"partial": true`.

Worker-set error codes: `op_failed`, `navigate_timeout`, `selector_timeout`,
`browser_launch_failed`, `spool_limit`, `render_failed`, `upload_failed`,
`job_timeout`, `lease_expired`.

| status | meaning |
|---|---|
| 200 | the job |
| 401 | `unauthorized` |
| 404 | `not_found`, including a job belonging to another org |

---

## GET /v1/jobs

List, newest first.

Query: `project` (slug), `status` (repeatable), `limit` (1 to 100, default 20),
`cursor` (opaque, from the previous page).

```json
{
  "jobs": [ { "id": "…", "status": "done", "…": "…" } ],
  "next_cursor": "eyJjIjoiMjAyNi0wOS0yM1QxMTowNDowMloifQ"
}
```

`next_cursor` is absent on the last page. It is keyset based on `(created_at, id)`, so a
job submitted mid pagination does not shift a page and cause a duplicate.

---

## GET /v1/jobs/{id}/artifact

Fetch the MP4. Query: `kind`, one of `video` (default), `poster`, `telemetry`, `log`.

Default behaviour is `302 Found` with a `Location` pointing at a signed URL on the
download host, valid for five minutes, because that keeps large downloads off this Worker
and off our egress path.

The signature travels in the path rather than in a query string. Every link to one object
is then a different string, so the download host can verify first and look the object up
under one canonical cache key, and a single cached copy serves every link.

```
HTTP/1.1 302 Found
Location: https://dl.kaviri.dev/1/<expiry base36>/<signature>/a/d30/<org id>/<job id>/video.mp4
Cache-Control: private, max-age=0
```

`?redirect=false` returns the URL in a body instead, for a caller that cannot follow a
redirect without losing its `Authorization` header:

```json
{ "url": "https://dl.kaviri.dev/1/…", "expires_at": "2026-09-23T11:11:00Z", "bytes": 8123456 }
```

| status | meaning |
|---|---|
| 302 | the signed URL |
| 200 | with `redirect=false` |
| 404 | `not_found`: no such job, or no artifact of that kind, or not yours |
| 409 | the job exists and is not `done` or `failed` yet. `detail.status` says where it is. |
| 410 | `gone`: retention swept it. `detail.expired_at` says when. |

---

## POST /v1/jobs/{id}/cancel

No body.

```json
{ "id": "4a2c…", "status": "running", "cancel_requested": true }
```

| status | meaning |
|---|---|
| 200 | the job was `queued` and is now `cancelled` |
| 202 | the job is on a box; cancellation is requested and takes effect within one heartbeat, about 15 seconds |
| 404 | `not_found` |
| 409 | `job_not_cancellable`: already `done`, `failed`, `cancelled` or `expired` |

---

## GET /v1/usage

The current calendar month in UTC, for the authenticated org. Quantities and limits. No
money: this service does not know what anything costs.

```json
{
  "period_month": "2026-09-01",
  "usage": {
    "jobs_submitted": 412,
    "jobs_completed": 402,
    "jobs_failed": 10,
    "render_seconds": 38104.5,
    "bytes_stored": 31457280000
  },
  "limits": {
    "plan_code": "unmetered",
    "max_concurrent_renders": 8,
    "max_jobs_per_month": null,
    "max_render_seconds_per_month": null,
    "max_stored_bytes": null,
    "max_job_seconds": 1800,
    "max_script_ops": 2000,
    "artifact_retention_days": 30
  }
}
```

A `null` limit means unlimited, and a tenant limit is `null` until something writes one
into `org_entitlements`. On a deployment with no billing service nothing ever does, so
every tenant limit stays `null` and only the platform ceilings have values, which is what
the self-hosted and clean-checkout deployments show.

`BILLING_MODE` is worth being precise about, because it is easy to read it as a switch and
it is not one. No code in this repository reads it: it names which deployment you are
looking at, and the unmetered behaviour comes from the database, where the absence of a
written limit is the absence of a limit. Setting `BILLING_MODE=none` against a database
whose `org_entitlements` rows already carry limits would not lift them. If you need a
tenant unmetered, clear the limits on its row.

---

## GET /v1/health

Unauthenticated. For uptime checks and for the Action to fail fast with a useful message
when the service is down rather than when a submission times out.

```json
{ "ok": true, "queue": { "queued": 12, "running": 3 }, "version": "2026.09.23-1" }
```

`503` with `{"ok": false}` when the queue is not accepting work.

---

## What the GitHub Action does with all this

1. `POST /v1/jobs` with the script, the preset, `source` from the `github` context, and
   `idempotency_key` set to `"gha-${run_id}-${run_attempt}"`.
2. Poll `GET /v1/jobs/{id}`, honouring `Retry-After`, until the status is terminal.
3. On `done`, `GET /v1/jobs/{id}/artifact` and write the MP4 into the workspace.
4. On `failed`, print `error.message`, download the partial video if there is one, and
   exit non-zero.
5. Emit `video`, `job-id` and `job-url` as step outputs.

The Action keeps its existing local mode. `kaviri-cloud` is an opt-in backend, chosen by
supplying an API key, and a workflow with no key still builds the recorder and films
locally with no account and no network call to us.
