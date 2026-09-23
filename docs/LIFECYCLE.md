# The job lifecycle

A render job is a row in `render_jobs` and a token moving through eight states. The
machine is enforced by a trigger, `render_jobs_state_machine`, over the edge list in
`app.is_legal_transition`. Nothing writes `state` directly: it moves through
`submit_job`, the three worker functions, `request_cancel`, `reap_expired_leases` and
`expire_due_artifacts`, and through nothing else. Clients have no `UPDATE` grant on the
column at all.

## The states

```
                          submit_job
                              |
                              v
                          [ queued ] <--------------------+
                              |                           |
              lease_next_job  |                           | retry, with backoff:
                              v                           | reap_expired_leases or
                          [ leased ]  ------------------->+ complete_job(failed)
                              |                           |
             report_progress  |                           |
                              v                           |
                          [ running ] ------------------->+
                              |                           |
             report_progress  |                           |
                              v                           |
                        [ uploading ] ------------------->+
                              |
                complete_job  |
                              v
                          [ done ] -----> [ expired ]
                                   expire_due_artifacts

  any in-flight state, attempts exhausted or the worker said retryable:false --> [ failed ]
  queued --> [ cancelled ] immediately;  in-flight --> [ cancelled ] on the next heartbeat
```

| state | what it means | what the customer sees |
|---|---|---|
| `queued` | accepted and waiting for a box. `visible_at` may hold it back for a retry backoff. | `"status": "queued"`, with `queue_position` when it can be computed. The API returns `Retry-After: 5`. |
| `leased` | a worker has claimed it and is starting Chromium. | `"status": "running"`, `progress: 0`. The distinction between leased and running is fleet bookkeeping and is not worth a customer-visible state. |
| `running` | the recorder is executing ops and capturing frames. | `"status": "running"` with `progress` between 0 and 1 and a `message` such as `"op 12 of 31: click #buy"`. |
| `uploading` | capture is over, ffmpeg has rendered, the MP4 is going to R2. | `"status": "running"`, `progress` near 1, `message: "uploading"`. Deliberately not a separate public status: from outside it is still "not ready yet". |
| `done` | the artifact row exists and the object is in the bucket. | `"status": "done"` with `artifacts[]` and a `Location` from the artifact endpoint. Terminal for the customer. |
| `failed` | out of attempts, or a failure the worker marked as not worth retrying. | `"status": "failed"` with a stable `error.code` and a human `error.message`. A partial video may still be attached: the recorder renders what it captured when a script fails mid way. |
| `cancelled` | the customer asked and the job stopped. | `"status": "cancelled"`. No artifact, and no render seconds beyond what was already burned. |
| `expired` | retention elapsed and the objects were swept. | `"status": "expired"`, `artifacts: []`, and `410 Gone` from the artifact endpoint rather than a `404`, because the difference between "never existed" and "you waited too long" is worth telling a customer. |

`done`, `failed`, `cancelled` and `expired` are terminal with one exception:
`done` becomes `expired` when retention runs out. That is the only edge out of a state a
customer has already seen as final, which is why the table above calls `done` terminal
for the customer rather than simply terminal.

## Leasing: how two workers never take the same job

`lease_next_job` selects one candidate row with `FOR UPDATE SKIP LOCKED` and updates it
in the same statement. `SKIP LOCKED` is the whole mechanism: a second worker arriving
during the first worker's transaction steps over the locked row and takes the next one
instead of blocking behind it. There is no advisory lock, no polling of a "claimed by"
column and no read-then-write window for two workers to race through.

The lease itself is three columns that move together, guarded by a check constraint so
half a lease cannot exist:

- `lease_token`, a fresh UUID returned to the worker exactly once. It is the worker's
  authority over this job, and the only one it gets.
- `lease_worker_id`, free text the fleet sets to something it can find in its own logs.
- `lease_expires_at`, now plus the requested lease seconds, clamped to between 15 and 900.

`report_progress` and `complete_job` each require the token and refuse a lease that has
already expired. That refusal is not pedantry: an expired lease may already have been
reaped and the job given to somebody else, and the stalled worker has to learn that it
lost rather than overwrite the winner's result.

A job is only offered to the fleet if its org is under `max_concurrent_renders`, counted
live inside `lease_next_job`. An org at its limit leaves its jobs `queued` and visible,
rather than having them rejected at submit time, because concurrency is a property of the
moment and not of the queue.

## Reaping: what happens when a worker dies

A render box can die in ways it cannot report. `reap_expired_leases` runs every minute
(`pg_cron`, or an external scheduler where `pg_cron` is unavailable) and takes every job
in `leased`, `running` or `uploading` whose `lease_expires_at` is in the past.

- Attempts remaining: back to `queued`, with `visible_at` pushed out by
  `10 * attempt` seconds. Short, because a lapsed lease usually means the box is gone
  rather than that the work is wrong.
- Attempts exhausted: `failed`, with
  `error.code = "lease_expired"` and `retryable: false`, naming the worker id and the
  attempt count.

The reaper also uses `SKIP LOCKED`, so a run that overlaps a worker's `complete_job`
leaves that job alone instead of blocking behind it and then undoing it.

Recommended heartbeat: call `report_progress` every 15 seconds with a 120 second lease.
That survives one lost heartbeat and a slow render pass without ever leaving a dead box
holding a job for more than two minutes.

## Retries

`attempt` starts at 0 and is incremented by `lease_next_job`, so a job on its first run
reads `attempt = 1`. `max_attempts` defaults to 3 and is capped at 10. The counter is
enforced monotonic by the trigger, because a worker that could reset it could retry
forever.

A job returns to `queued` when:

- the lease was reaped and `attempt < max_attempts`; or
- the worker called `complete_job` with outcome `failed`, `attempt < max_attempts`, and
  the error was not marked `retryable: false`.

Backoff on a reported failure is exponential from the attempt just consumed:
15s, 60s, 240s. Long enough for a flaky box to be replaced, short enough that a CI job
waiting on the video does not time out before the retry has even started.

Retryable is the default, because most of what goes wrong on a render box is transient:
Chromium would not start, the frame spool filled, the machine was reclaimed. A worker
that knows better sets `retryable: false`, which is the right answer for a bad selector
or an unreachable URL, since filming it again changes nothing.

Every attempt meters its own render seconds. The job's `render_seconds` is the sum across
attempts, and the ledger carries one row per attempt, so a customer asking why a
twenty second take cost ninety seconds can be shown the three attempts.

## Cancellation

A `queued` job is cancelled outright, in the same transaction as the request.

A job already on a box is only flagged: `request_cancel` sets `cancel_requested`, the
worker sees it on its next heartbeat, tears down the browser and calls `complete_job`
with outcome `cancelled`. Killing a render mid encode would strand a multipart upload in
the bucket that no row points at, which is a storage leak nobody is watching for.

So a cancel is acknowledged immediately and takes effect within one heartbeat, and the
API says so: `POST /v1/jobs/{id}/cancel` returns `202` with the current status rather
than pretending the job has already stopped.

## Retention and expiry

`complete_job` stamps `expires_at` on the job and on every artifact, from the org's
`artifact_retention_days` (30 by default).

`expire_due_artifacts` runs hourly. It marks artifact rows `deleted_at` and returns their
storage keys; a separate sweeper deletes the objects. The order is deliberate. A database
transaction cannot roll back an object delete, so the row is marked first. The worst case
is an object that outlives its row by one sweep, which costs storage. The reverse, a live
row pointing at a deleted object, costs a customer a broken link in a README.

A job becomes `expired` only once every artifact it owns is gone, so a take whose
telemetry sidecar expired first does not report itself as expired while the video is
still downloadable.

## Invariants worth knowing

- A job is always inserted `queued`. A birth trigger enforces it, because a row created in
  any other state would be a second, undocumented entry to the machine.
- A lease exists if and only if the state is `leased`, `running` or `uploading`.
- `finished_at` is set if and only if the state is terminal.
- `attempt` never decreases.
- `usage_events` is append only, enforced by a trigger. The value of a ledger is exactly
  that nobody can quietly adjust last month.
