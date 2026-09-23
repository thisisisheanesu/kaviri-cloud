# The render image

One pinned browser, one pinned encoder, one recorder binary, and a font set chosen on
purpose. This image is the sandbox a customer's script runs in, so most of what follows is
about what it is not allowed to do.

```sh
./docker/resolve-pins.sh > docker/pins.env   # once, and commit the result
./docker/build.sh                            # build kaviri-render:local
sudo ./docker/egress.sh                      # network, fence, boot time unit, and a proof
sudo ./docker/egress.sh --verify             # re-check an existing fence, change nothing
```

`egress.sh` ends by running a container on the render network and trying to connect to the
addresses it just blocked. If they answer, it exits non zero. A provisioning run that
succeeds has therefore demonstrated the fence rather than described it.

The worker never builds or pulls the image. `kaviri-render-worker doctor` fails if it is
not already present, because a box that silently pulls a newer image is a box that changed
what every customer's video looks like without anybody deciding to.

## Fonts, and why there are so many of them

Fonts are the single most likely cause of "the video looks broken and nobody knows why".
Nothing errors. The take succeeds, the MP4 is the right length, and the text is boxes.
There is no signal anywhere in the pipeline, because from the recorder's point of view the
page rendered fine.

So the image carries a real font set rather than whatever a browser package happens to pull
in:

| package | what it covers | why it is here | roughly |
|---|---|---|---|
| `fonts-dejavu-core` | Latin, Greek, Cyrillic | the last resort fallback, and what fontconfig reaches for when everything else misses | 2 MB |
| `fonts-liberation2` | Arial, Times New Roman, Courier New metrics | a page asking for Arial gets something with Arial's metrics. Substituting a font of different width reflows the layout, and the video then shows a layout no user of the product will ever see | 3 MB |
| `fonts-noto-core` | Latin, Greek, Cyrillic, Arabic, Hebrew, Devanagari, Thai and most other living scripts | the broad coverage layer. Any product with a non-Latin customer base films correctly | 50 MB |
| `fonts-noto-mono` | monospace | every developer tool demo is a terminal or a code block | 1 MB |
| `fonts-noto-color-emoji` | emoji | emoji are in product UI now, in buttons and empty states. Without this they are tofu, and tofu in a marketing video is the failure this table exists to prevent | 10 MB |
| `fonts-noto-cjk` | Chinese, Japanese, Korean | see below | 110 MB |

The figures are approximate and the build prints the real ones; `dpkg-query -W -f='${Installed-Size}\t${Package}\n'`
inside the image is the exact answer for a given pin.

### The CJK tradeoff

`fonts-noto-cjk` is roughly 110 MB installed, which is more than everything else in the
table put together and is most of the image's font budget. It is included anyway, and the
reasoning is worth writing down because it is the one entry somebody will want to remove:

- **What it buys.** A Japanese, Chinese or Korean page renders as text rather than as rows
  of boxes. There is no partial version of this: CJK coverage is all or nothing per script,
  and a page with one Japanese label in a Latin UI is just as broken as a fully Japanese
  one.
- **What it costs.** About 110 MB on the image, which is pull time on a new box and disk on
  an existing one. It costs nothing per take: the image is pulled once and the font is
  memory mapped by Chromium only if a page actually uses it.
- **Why the cost is the cheap kind.** Our scaling unit is the box, not the container. An
  image layer is paid for when a box is provisioned and never again, whereas a missing glyph
  is paid for by one customer, silently, in the artifact they were going to put on their
  home page.

`fonts-noto-cjk-extra` is deliberately **not** installed. It is another 200 MB or so for
Hong Kong variants and weights that a screen recording will not distinguish, which is the
point where the tradeoff turns over.

Two related settings, for the same reason:

- `fc-cache --force --system-only` runs at build time. With a read only root filesystem a
  Chromium that had to build the cache would rebuild it on every single take, into the
  tmpfs, and pay for it in the first second of every video.
- Chromium's `--font-render-hinting` is deliberately not set. The recorder captures at `--scale 2`
  or higher, so hinting decisions are supersampled away, and pinning a hinting mode here
  would make the image's output differ from what the same page looks like on the
  customer's own machine.

## Safety: this image runs code a stranger wrote

A kaviri script is a list of URLs to open and things to click. Opening a URL runs that
site's JavaScript. So the image is treated as though every take is hostile, because one of
them eventually will be.

### One job per container, destroyed after

`docker run --rm`, one container per take, nothing reused. The container is not a packaging
convenience; it is the boundary. This is also the answer to the one thing the network rules
cannot cover: the recorder talks to Chromium over CDP on the container's own loopback, and
a page can in principle reach a loopback port. Because there is never a second customer's
take in the same container, the worst that reaches is the browser filming its own take.

### What the container is given

Set by the worker on every `docker run`, in `render-worker/src/backend/docker.rs`:

```
--rm --init
--network kaviri-egress
--user <the worker's own uid>:<gid>
--cap-drop ALL
--security-opt no-new-privileges:true
--read-only
--tmpfs /tmp:rw,nosuid,nodev,size=256m
--shm-size 1g
--memory 4g --memory-swap 4g      (equal, so the container cannot swap)
--cpus 3
--pids-limit 1024
--mount type=bind,src=<job dir>,dst=/work
--mount type=bind,src=<spool dir>,dst=/spool
```

`--init` matters more than it looks: tini as pid 1 is what makes the SIGTERM that truncates
a take reach the recorder, and what reaps the Chromium children that would otherwise
accumulate against `--pids-limit`.

`--memory-swap` equal to `--memory` disables swap for the container. A swapping take is
worse than a failed one: the frames still arrive, the wall clock still runs, and the
customer gets a slideshow.

### Network egress

Two layers, and they do different jobs.

**Layer one, Chromium's resolver.** The worker sets exactly this, as
`KAVIRI_CHROMIUM_ARGS`:

```
--host-resolver-rules=MAP metadata.google.internal ~NOTFOUND,MAP metadata ~NOTFOUND,
MAP metadata.goog ~NOTFOUND,MAP instance-data ~NOTFOUND,
MAP instance-data.ec2.internal ~NOTFOUND,MAP 169.254.169.254 ~NOTFOUND,
MAP *.internal ~NOTFOUND,MAP *.cluster.local ~NOTFOUND,MAP *.local ~NOTFOUND,
MAP localhost ~NOTFOUND,MAP *.localhost ~NOTFOUND
```

(one flag, comma separated, wrapped here for reading). `~NOTFOUND` makes the name fail to
resolve, which the page sees as an ordinary DNS failure. A hang would eat the take's wall
clock budget instead.

**This flag is not a security control, and it is important to say so.** Chromium's host
resolver is not consulted for a URL that already contains an IP literal, so
`http://169.254.169.254/` does not pass through these rules at all. What the rules close is
every *name* based route to the same places, which is what a script copied off the internet
will actually contain, and what a misconfigured internal tool will resolve to.

**Layer two, netfilter.** `docker/egress.sh` is the control that actually holds. It creates
the `kaviri-egress` bridge on `172.31.240.0/24` with inter container communication off, and
installs a `KAVIRI-EGRESS` chain that rejects, from that subnet:

```
0.0.0.0/8  10.0.0.0/8  100.64.0.0/10  127.0.0.0/8  169.254.0.0/16
172.16.0.0/12  192.0.0.0/24  192.168.0.0/16  198.18.0.0/15  224.0.0.0/4  240.0.0.0/4
```

jumped to from `DOCKER-USER` for forwarded traffic and from `INPUT` for traffic addressed
to the host itself, which is delivered locally and would otherwise never reach
`DOCKER-USER`. `REJECT` rather than `DROP`, so a probe fails in milliseconds rather than
consuming the take's whole budget.

The network is IPv4 only. Not because IPv6 is a problem, but because a second address
family is a second complete set of rules and a box that forgets the second set has the
fence it thinks it has in one family only.

**Layer three, the worker refusing to start.** The two layers above are configuration, and
configuration has a lifetime. A docker network is daemon state and comes back after a
reboot; the iptables rules are kernel state and do not. That asymmetry is the dangerous
one, because a rebooted box inspects entirely clean: the network is there, the worker's old
startup check passed, and the only thing missing is the boundary.

So `egress.sh` installs `kaviri-egress.service`, which re-runs it at every boot, and the
worker's preflight no longer asks whether the network exists. It runs one container on that
network and tries to connect:

| target | required answer |
|---|---|
| `169.254.169.254:80` | refused |
| `10.255.255.1:80` | refused |
| `KAVIRI_EGRESS_PROBE_PUBLIC`, `1.1.1.1:443` by default | connected |

If any of those comes out differently, the worker exits with an explanation instead of
leasing a job. Four things about that table are deliberate:

- **Two blocked addresses, not one.** A fence installed for the famous CIDR and not the
  rest is a realistic half configured box, and a probe that only tries 169.254.169.254
  cannot tell it from a correct one.
- **A connection timing out is a failure, not a pass.** `egress.sh` uses `REJECT`, so a
  fenced address answers in milliseconds. Silence means some other filter, and the worker
  does not rely on a boundary it did not install.
- **The positive control is what makes the refusals mean anything.** A render network with
  no route anywhere refuses 169.254.169.254 exactly as convincingly as a fenced one. Set
  `KAVIRI_EGRESS_PROBE_PUBLIC=off` on a box with no general egress and the worker starts,
  and says at WARN that the fence is now unverified.
- **No override for the blocked half.** There is no environment variable that makes the
  worker film on an unfenced network, because the only reason to want one is to do the
  thing this check exists to prevent.

`sudo docker/egress.sh --verify` runs the same probe by hand and changes nothing.

There is a third layer worth building later and not built now: an explicit HTTP proxy the
container is forced through, which would let a take be allowlisted to the domains its
script actually names. That is the right long term answer and it is more moving parts than
a launch needs.

### The disk

- The recorder is passed `--max-spool-bytes` (8 GiB by default) and stops the take cleanly
  when it is reached, rendering what it has.
- The worker runs its own watchdog every five seconds over **the whole job directory**, and
  stops the container above `max_spool_bytes * 1.25 + max_artifact_bytes`. Three terms
  because there are three writers: the frame spool, the CFR intermediate that lands under
  the same `TMPDIR` and is not counted against the recorder's cap, and `take.mp4` itself,
  which is written into `/work` and which a watchdog pointed at `/spool` cannot see at all.
  The artifact term is added rather than folded into the 25% so that a legitimate two
  gigabyte video does not eat the intermediate's headroom.
- The worker refuses to start if the work root has less than `KAVIRI_MIN_FREE_BYTES` free,
  16 GiB by default, **and checks again before every take**. The startup check answers "was
  this box ever ready", which a process that lives for weeks stops being able to answer
  honestly: a take spools at 15 to 25 MB per second and an abandoned container or a
  co-tenant can eat the disk between two jobs. A take handed back before its container
  starts costs a requeue; one that fills the disk mid render costs the next few jobs too.

### The clock

The wall clock budget is the smaller of the org's `max_job_seconds` and the worker's own
`KAVIRI_JOB_SECONDS_CAP`. At the budget the take is **truncated, not failed**: SIGTERM
reaches the recorder, capture stops, ffmpeg renders what was captured, and the customer
gets the first part of their demo with a message saying it was cut. Only if that produces
no usable video does the job fail, with `job_timeout`.

`docker stop --time <render grace>` sends SIGTERM and then SIGKILL, so a render pass that
itself hangs is still bounded.

### Logging

A script is customer data and may contain a password somebody pasted into a login demo.
Nothing in this image or the worker logs a script, an op's `text`, or a URL's path or query
string. `render-worker/src/redact.rs` is the only way text from a take reaches a log line,
and it is allow list based: a field is logged because it was decided to be safe, never
because it did not look like a secret.

The telemetry sidecar is the deliberate exception, and it is off unless the customer asks
for it per job. It carries every navigate URL verbatim, including query strings. When asked
for it becomes an artifact of the customer's own job, readable by their org and nobody
else, and the worker uploads it without reading it.

### Chromium's own sandbox

The worker probes once at startup whether the host allows unprivileged user namespaces, by
running `unshare -U true` in the image. If it does, Chromium's sandbox stays on and there
are two boundaries around a page: Chromium's and the container's. If it does not, which is
the default on Ubuntu 24.04 because AppArmor restricts unprivileged user namespaces, the
worker logs a warning at WARN and films with `--no-sandbox`, leaving the container as the
only boundary.

That is a real reduction in isolation and the log line says so. To keep both boundaries on
Ubuntu 24.04, either set `kernel.apparmor_restrict_unprivileged_userns=0` or install an
AppArmor profile for the browser. Debian bookworm, which the image is based on and which is
a sensible choice for the host too, allows them by default.
