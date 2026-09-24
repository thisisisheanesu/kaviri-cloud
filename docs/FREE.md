# Running the whole thing for nothing

Everything kaviri needs has a free tier except the render box, and the render box has three
answers depending on how much you care about it being up when you are asleep. This is the
zero-cost topology, what each piece gives up, and the exact line at which it stops being free.

None of this changes the code. It is the same binaries and the same schema with different
endpoints, which is the point of `KAVIRI_S3_ENDPOINT` existing.

## The stack

| piece | free option | ceiling | what happens at the ceiling |
|---|---|---|---|
| Database, queue, entitlements | Supabase free | 500 MB, 5 GB egress a month | reads start failing |
| Artifact storage | Supabase Storage free | **1 GB** | uploads fail, jobs fail at the upload step |
| Edge API and downloads | Cloudflare Workers free | 100k requests a day | 429 until midnight UTC |
| Waitlist and the Stripe buffer | Cloudflare D1 free | 5 GB, 5M rows read a day | same |
| Owner notifications | Cloudflare Email Routing | to verified addresses only | cannot mail a customer |
| Signup confirmations | Resend free | 3,000 a month, 100 a day | queued by the hourly retry |
| CI | GitHub Actions | unlimited on public repos | nothing; both repos are public |
| The recorder itself | free forever, Apache 2.0 | none | none |
| **Render box** | see below | | |

The two numbers that bite first are **1 GB of artifacts** and **500 MB of database**. At a 500
KB video that is about two thousand takes held, which for a pre-launch service is a long way
away, and the retention sweep already deletes expired ones.

## The render box, which is the only real problem

It needs Chromium, ffmpeg and minutes of CPU per job. Nothing serverless does that, so
something has to be running.

**1. This laptop.** Free today, already has both binaries, already proven: the recorder runs
here every time the demo is re-filmed. Point `SUPABASE_URL` and a `kaviri_worker` JWT at the
live project and it leases and renders real jobs. The catch is obvious and it is fine for now:
jobs queue while the lid is shut. The queue is durable and the lease reaper puts back anything
that was in flight, so nothing is lost by closing it, which is a property worth having tested
before trusting.

**2. Oracle Cloud Always Free.** Four ARM cores and 24 GB, free with no time limit, which is
more machine than the $118 Hetzner box this was costed against. ARM64 is fine: the worker is
Rust, Chromium ships arm64, ffmpeg ships arm64. This is the answer if you want it up while you
sleep and it costs nothing. The cost is a signup and an account that can be reclaimed if idle.

**3. Google Cloud Run.** 180,000 vCPU-seconds free a month, which at 0.05 core-hours a render
is about a thousand renders, and it scales to zero. Needs a card on file even to stay inside
the free tier.

Start with the laptop, because it is free and it is today. Move to Oracle when the first person
who is not you submits a job.

## Storage: why this is Supabase and not R2, for now

R2 is better for this product and the reason is egress. Supabase charges about $0.09 per GB
out; R2 charges nothing. The artifacts are MP4s hotlinked from READMEs, so egress is the
variable cost that matters: one popular video at 15 MB served ten thousand times a month is 150
GB, which is **$13.50 on Supabase and $0 on R2**.

It is Supabase here anyway, for two reasons. Enabling R2 needs a payment method on the
Cloudflare account, and at pre-launch volume the egress is a rounding error against a 5 GB
monthly allowance. The moment a single take gets popular, that flips hard.

`KAVIRI_S3_ENDPOINT` is how it flips. Supabase Storage speaks S3, so it is a variable, not a
port:

    # Supabase Storage, free
    KAVIRI_S3_ENDPOINT=https://<ref>.storage.supabase.co/storage/v1/s3
    KAVIRI_S3_REGION=<the project region, eg eu-central-1>
    R2_BUCKET=artifacts

    # R2, when egress starts to cost
    # KAVIRI_S3_ENDPOINT unset, and R2_ACCOUNT_ID set instead
    KAVIRI_S3_REGION=auto

The `R2_` names for the bucket and the keys are now wrong for the Supabase case and worth
renaming the day this stops being an experiment.

## The one that will catch you out

**A free Supabase project pauses after about a week of no activity, and a paused project is a
dead service that does not announce itself.** The site Worker's hourly cron now makes one
authenticated request to the project to prevent that. It is in `wsrc/waitlist.js` as
`keepDatabaseAwake`, and it needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` set as Worker secrets
or it is a no-op that says so.

This is a stopgap and should be deleted the day the project is on Pro. A service that depends
on a keep-alive ping is a service with a single point of quiet failure.

## When free stops

In the order they will actually happen:

1. **Somebody else's demo gets popular.** Egress. Move artifacts to R2, which needs a card on
   Cloudflare but stays free to about 10 GB held.
2. **The first paying customer.** Supabase Pro at $25, because a production database must not
   pause and a free one has no backups worth the name.
3. **Renders queue during working hours.** The second box, which is the first real $118.

Until then it is $0 a month, and the fixed-cost model in `kaviri-billing/docs/PRICING.md`
describes the shape of the business rather than this month's bill.
