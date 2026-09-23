# render-worker

The thing that actually renders. A long lived process on one Hetzner box: it leases a job
from the queue, films it in a container that is destroyed afterwards, uploads the MP4 to
R2, and reports the outcome.

```
lease_next_job ──► write script.jsonl ──► docker run (one take, --rm) ──► ffprobe
                                                │                           │
                                     report_progress every 15s        put to R2
                                     (lease, progress, cancel)             │
                                                                     complete_job
```

## What it holds, and what it deliberately does not

A JWT for the Postgres role `kaviri_worker`, and an R2 credential. That role can execute
`lease_next_job`, `report_progress` and `complete_job` and can select, insert and update
nothing. There is no service role key here, because this is the machine that runs customer
supplied scripts and that is exactly the machine that should not be able to read another
tenant's row. A box that is compromised can lease jobs and lie about their outcome, which
is bad but bounded.

Within those three functions authority is per job. `lease_next_job` mints a `lease_token`
and returns it once; every later call carries it. A worker that stalled, lost its lease to
the reaper and then woke up finds its heartbeat refused with `42501`, stops the take and
says nothing further about a job it no longer owns.

## Running it

```sh
cargo build --release
KAVIRI_LOG_FORMAT=text ./target/release/kaviri-render-worker doctor
./target/release/kaviri-render-worker
```

`doctor` checks the configuration, the docker daemon, the presence of the render image and
the egress network, the user namespace probe and the free disk, then exits. It is the
`ExecStartPre` of the systemd unit, so a misconfigured box fails to start rather than
starting and leasing a customer's job it cannot film.

Deployment is `docker/kaviri-render-worker.service`, with secrets in
`/etc/kaviri/worker.env` at mode 0600. Nothing in this repository contains a credential.

## Configuration

Every variable, its default, and what it is for. Required ones have no default.

| variable | default | what it does |
|---|---|---|
| `SUPABASE_URL` | required | the project the queue lives in |
| `SUPABASE_ANON_KEY` | required | PostgREST's `apikey` header. It grants nothing on its own |
| `KAVIRI_WORKER_JWT` | required | role `kaviri_worker`. The worker's whole authority |
| `KAVIRI_WORKER_ID` | the hostname | what appears in `lease_worker_id`. Make it unique per box |
| `KAVIRI_LEASE_SECONDS` | 120 | clamped by the database to 15 to 900 |
| `KAVIRI_HEARTBEAT_SECONDS` | 15 | refused at startup if it is more than a third of the lease |
| `KAVIRI_POLL_IDLE_MS` | 2000 | how long to wait after an empty queue |
| `R2_ACCOUNT_ID` `R2_BUCKET` `R2_ACCESS_KEY_ID` `R2_SECRET_ACCESS_KEY` | required | artifact storage |
| `KAVIRI_RENDER_BACKEND` | `docker` | the only one implemented today |
| `KAVIRI_MAX_CONCURRENT_JOBS` | 1 | takes in flight on this box |
| `KAVIRI_WORK_ROOT` | `/var/lib/kaviri/work` | job directories and frame spools |
| `KAVIRI_RENDER_IMAGE` | `kaviri-render:local` | must already be present; the worker never pulls |
| `KAVIRI_DOCKER_NETWORK` | `kaviri-egress` | created by `docker/egress.sh` |
| `KAVIRI_EGRESS_PROBE_PUBLIC` | `1.1.1.1:443` | the positive control for the startup fence probe; `off` disables it |
| `KAVIRI_CONTAINER_MEMORY` | `4g` | also the swap limit, so the container cannot swap |
| `KAVIRI_CONTAINER_CPUS` | `3` | one for the browser, one for the capture pump, one for ffmpeg |
| `KAVIRI_MAX_SPOOL_BYTES` | 8 GiB | passed to the recorder, and the basis of the watchdog |
| `KAVIRI_JOB_SECONDS_CAP` | 1800 | the worker's own ceiling, applied over the lease's |
| `KAVIRI_RENDER_GRACE_SECONDS` | 300 | time the render pass gets after a truncation |
| `KAVIRI_MAX_ARTIFACT_BYTES` | 2 GiB | a larger take is not uploaded, and part of the watchdog ceiling |
| `KAVIRI_MIN_FREE_BYTES` | 16 GiB | refuse to start below this, and hand back any take leased below it |
| `KAVIRI_LOG` | `info` | tracing filter |
| `KAVIRI_LOG_FORMAT` | JSON | `text` for a human on the box |

`BILLING_MODE` is not in that table and the worker does not read it. Nothing here knows
what a plan is. It reads `max_job_seconds` off the lease, which already carries the
platform ceiling, and clamps its own on top.

## How a take is decided

| what happened | reported as | retried |
|---|---|---|
| clean exit, usable video | `done` | |
| wall clock reached, usable video | `done`, with a message saying it was truncated | |
| wall clock reached, nothing usable | `job_timeout` | no |
| spool watchdog tripped | `spool_limit` | no |
| an op failed | `op_failed`, `navigate_timeout` or `selector_timeout` | no |
| the browser never started | `browser_launch_failed` | yes |
| anything else with no video | `render_failed` | yes |
| the upload failed | `upload_failed` | yes |
| the customer cancelled | `cancelled`, no artifact | |
| the container could not be killed | **nothing is reported** | by the reaper |

Three rules behind that table.

**Truncation is a success.** A take that outran its budget is cut short and rendered, and
the customer gets the first part of their demo rather than an error. The signal is the
final progress message, since a `done` job carries no error object.

**A customer's fault is never retried.** A script that fails on op 7 fails on op 7 again,
and retrying would charge them three times the render seconds for the same answer. A box's
fault always is, because most of what goes wrong on a render box is transient.

**The last row reports nothing on purpose.** At the wall clock the container is asked to
stop, then killed, and the kill is retried three times thirty seconds apart. If it is still
running after that, this worker has run out of ways to end it, and the container may still
be filming into the bind mount. Saying `failed` would end a take that has not ended, and
saying anything at all would renew the lease and keep the reaper away from the one job that
needs it. So the worker stops the heartbeat, lets the lease lapse, logs at ERROR, marks
itself unhealthy and exits non zero once the other takes in flight have drained. The reaper
requeues the job on a box that works, and systemd restarts this one into a preflight that
will diagnose the daemon properly.

That is the difference a state machine makes. The previous version armed the hard kill on
`stopping && !outcome.killed` and set `killed` before spawning it, so a single failed
`docker kill` disabled the timer permanently: the loop then waited on `child.wait()` for as
long as the worker lived while the heartbeat kept renewing the lease, and the job could
never be reclaimed by anyone.

A partial video is uploaded only when the attempt is the last word, which is when the
failure is not retryable or the attempt count is spent. Attaching one to a job that is
about to be requeued would put an artifact row on a `queued` job, and the retry would
overwrite it anyway.

## The RenderBackend trait

One Hetzner box at launch, behind `backend::RenderBackend`. Not Modal: the owner's Modal
account was disabled by a spend cap in August, which is the render fleet going dark on a
billing event, and a demo video that is a build artifact cannot have a build step that does
that.

The trait is four methods, and nothing in `RenderRequest` or `RenderOutcome` mentions a
container, a machine or a host. A Fly Machines backend creates a machine, waits for it,
streams its stdout, and destroys it, and satisfies the same contract. The one behaviour a
new backend must preserve is the truncation: at the soft deadline the recorder is asked to
stop **politely**, and what it captured is rendered. A backend that kills the process
instead turns every slow take into no take at all, and the tests in `job.rs` that assert a
truncated take is a success will not catch it, because they test the classifier rather than
the backend.

## Things worth knowing before changing this

- **Upload before report, always.** `complete_job` creates the artifact row and moves the
  state in one transaction, so a customer who sees `done` always has something behind the
  link. Reversing the order trades a storage leak, which a sweep fixes, for a broken link in
  somebody's README, which nothing fixes.
- **The heartbeat is also the cancel channel.** `report_progress` returns
  `cancel_requested`, so cancellation costs no extra round trip and takes effect within one
  beat. That is why the API promises about fifteen seconds.
- **The op counter runs one ahead.** The recorder answers the `start_recording` it inserts
  itself before it answers the first real op, so the count of `ok` envelopes is one more
  than the number of ops executed until the take ends.
- **Nothing logs a script.** See `redact.rs`. It is allow list based on purpose: a redactor
  that looks for things resembling secrets misses the one that does not resemble anything.

## Tests

`cargo test`. They are unit tests over the parts that are decisions rather than plumbing:
the classifier, the redactor, the URL fence, the option builder, the SigV4 key derivation
against the published AWS test vector. There is no integration test that films anything,
because that needs the image, a docker daemon and a Supabase project, and the one that
would be worth writing is an end to end take in CI against a real queue.
