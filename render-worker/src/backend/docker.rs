//! One job per container, destroyed after it.
//!
//! This is the launch backend: a single Hetzner box, one container per take, `--rm` so
//! nothing survives the job. The container is the isolation boundary, so it is built as
//! one rather than as a convenient way to ship a binary: no capabilities, no new
//! privileges, a read only root filesystem, a non root user, a pid ceiling, a memory
//! ceiling, and two bind mounts that are the only writable paths in it.
//!
//! One job per container matters for a reason beyond tidiness. A customer script runs
//! arbitrary JavaScript in a browser we started, and that browser's DevTools endpoint is
//! reachable on the container's own loopback. Even in the worst case, where a page reaches
//! that endpoint, the only session it can touch is the one filming its own take, because
//! there is never a second customer's take in the same container.

use super::{
    chromium_args, dir_size, MediaInfo, OpFailure, Phase, Progress, RenderBackend, RenderOutcome,
    RenderRequest, OUT_FILE, SCRIPT_FILE,
};
use crate::redact;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;
use tokio::time::Instant;

/// How many stderr lines are kept for the failure report. Enough to show the last thing
/// the recorder said and the two or three lines of context before it, and few enough that
/// a browser logging in a loop cannot make the worker hold a take's worth of text in
/// memory.
const STDERR_TAIL_LINES: usize = 40;

/// How much the spool may exceed the recorder's own cap before the watchdog stops the
/// take. The recorder caps the frame spool and clamps that cap to the free space it sees;
/// what it does not count is the CFR intermediate, which lands under the same TMPDIR
/// during the render. A quarter is enough headroom for that intermediate and not enough
/// to fill a disk that was sized for the cap.
const SPOOL_OVERSHOOT_NUMERATOR: u64 = 5;
const SPOOL_OVERSHOOT_DENOMINATOR: u64 = 4;

/// How many times `docker kill` is retried before the container is abandoned.
///
/// Three, spaced by `KILL_RETRY`, so a daemon that is briefly busy gets more than one
/// chance and a daemon that is wedged is not waited on forever. The number matters less
/// than the fact that it is finite: the bug this replaces armed the kill exactly once and
/// then disabled its own timer, so a failed kill meant the loop waited on a child that was
/// never going to exit while the heartbeat kept the lease alive.
const MAX_KILL_ATTEMPTS: u32 = 3;
const KILL_RETRY: Duration = Duration::from_secs(30);

/// Addresses a container on the render network must not be able to open a connection to.
///
/// Two of them, not one. 169.254.169.254 is the address the fence exists for, and
/// 10.255.255.1 is here because a fence installed for the famous CIDR and not the rest is a
/// realistic half configured box, and a probe that only ever tries the famous address
/// cannot tell that box apart from a correct one. Port 80 on both: the question is whether
/// a packet is allowed to leave, and the answer does not depend on anything listening.
const FENCED_ADDRESSES: &[(&str, u16, &str)] = &[
    ("169.254.169.254", 80, "metadata"),
    ("10.255.255.1", 80, "rfc1918"),
];

/// How long one connect attempt inside the probe container is given.
///
/// `egress.sh` REJECTs rather than DROPs, so a fenced address answers in milliseconds. Five
/// seconds is therefore not a timeout in the ordinary sense, it is the line between "the
/// fence refused this" and "something swallowed the packet", and the second of those is not
/// a fence this worker will start behind.
const PROBE_CONNECT_SECONDS: u32 = 5;

/// Ceiling on the whole probe container, so a wedged docker daemon fails startup instead of
/// hanging it. Comfortably more than every probe timing out in series.
const PROBE_CONTAINER_TIMEOUT: Duration = Duration::from_secs(90);

/// How much of an op name echoed back by the recorder is kept. The recorder is quoting the
/// customer's own script, so the length of this field is the customer's choice.
const OP_NAME_IN_ERROR: usize = 40;

pub struct DockerBackend {
    image: String,
    network: String,
    memory: String,
    cpus: String,
    /// See `Config::egress_probe_public`.
    probe_public: Option<String>,
    /// The container runs as the same uid as the worker, so the MP4 it writes into the
    /// bind mount is readable by the process that has to upload it without anything being
    /// world writable.
    uid: u32,
    gid: u32,
    /// Whether Chromium's own namespace sandbox can start on this kernel. Probed once,
    /// because the answer is a property of the host and asking per job would cost a
    /// container start on every take.
    sandbox_available: AtomicBool,
}

impl DockerBackend {
    pub fn new(cfg: &crate::config::Config) -> Result<DockerBackend, String> {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(&cfg.work_root)
            .map_err(|e| format!("cannot stat {}: {e}", cfg.work_root.display()))?;
        Ok(DockerBackend {
            image: cfg.render_image.clone(),
            network: cfg.docker_network.clone(),
            memory: cfg.container_memory.clone(),
            cpus: cfg.container_cpus.clone(),
            probe_public: cfg.egress_probe_public.clone(),
            uid: meta.uid(),
            gid: meta.gid(),
            sandbox_available: AtomicBool::new(false),
        })
    }

    fn container_name(job_id: &str) -> String {
        format!("kaviri-job-{job_id}")
    }

    /// Prove, by trying it, that a container on the render network cannot reach the
    /// addresses the fence exists to block.
    ///
    /// The previous startup check inspected the docker network and stopped there. That
    /// check cannot fail on a box whose fence is gone, because the two things have
    /// different lifetimes: `docker network create` writes state the daemon reloads at
    /// boot, while `iptables -I` writes state the kernel forgets at boot. A box that was
    /// set up correctly in March and rebooted in September inspects clean and films
    /// customer scripts with a live route to the metadata service.
    ///
    /// So the check is an experiment instead of a lookup. One container, on the real
    /// network, with the real restrictions, opening real TCP connections. It costs one
    /// container start per worker start, which is paid once per deploy, and in exchange the
    /// failure mode of a missing fence changes from "films everything with the boundary
    /// removed" to "does not start".
    ///
    /// A container start is also the only honest way to ask this question. Asking netfilter
    /// directly would mean the worker parsing `iptables-save`, which means the worker
    /// deciding whether a rule set it did not write has the effect the rule set it expected
    /// would have had, and that is a reimplementation of netfilter's matching semantics in
    /// a render worker.
    async fn verify_egress_fence(&self) -> Result<(), String> {
        let script = probe_script(self.probe_public.as_deref());
        let user = format!("{}:{}", self.uid, self.gid);
        let argv = vec![
            "run",
            "--rm",
            "--network",
            &self.network,
            "--user",
            &user,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=16m",
            "--entrypoint",
            "/bin/bash",
            &self.image,
            "-c",
            &script,
        ];

        let out = tokio::time::timeout(PROBE_CONTAINER_TIMEOUT, run_capture(&argv))
            .await
            .map_err(|_| {
                format!(
                    "the egress probe container did not finish within {}s; the docker daemon \
                     is not answering and this worker cannot show that its egress fence holds",
                    PROBE_CONTAINER_TIMEOUT.as_secs()
                )
            })??;

        match judge_egress(&out.stdout, self.probe_public.as_deref()) {
            Ok(notes) => {
                for note in notes {
                    tracing::info!("egress fence: {note}");
                }
                if self.probe_public.is_none() {
                    tracing::warn!(
                        "egress fence: the positive control is off (KAVIRI_EGRESS_PROBE_PUBLIC=off). \
                         The blocked addresses were refused, but with no reachable address to \
                         compare against, a render network with no route at all would look \
                         identical to a fenced one."
                    );
                }
                Ok(())
            }
            Err(reason) => Err(format!(
                "the egress fence on docker network {} does not hold: {reason}. \
                 Run `sudo docker/egress.sh` on this box and make sure it runs again after a \
                 reboot; the iptables rules it installs are not persistent on their own. \
                 This worker will not film customer scripts on an unfenced network. \
                 Probe stderr: {}",
                self.network,
                redact::token_for_log(out.stderr.trim(), 300)
            )),
        }
    }
}

/// What one connect attempt from inside the probe container did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reach {
    /// The connection was refused or the host was unreachable, promptly. This is what the
    /// fence's REJECT looks like from inside a container.
    Blocked,
    /// The connection was established. For a fenced address this is the failure the whole
    /// probe exists to catch.
    Open,
    /// Nothing came back before the deadline. Treated as a failure rather than a pass: the
    /// fence REJECTs, so silence is somebody else's DROP rule, a black holed route, or a
    /// filter we do not control and cannot reason about.
    Hung,
}

/// The shell the probe container runs.
///
/// bash's `/dev/tcp` rather than curl, because the render image deliberately carries no
/// network client and adding one to the image a customer's script runs in, purely so the
/// worker can check itself, would be a poor trade. `timeout` bounds each attempt and its
/// exit code carries the verdict: 0 is a completed connection, 124 is the deadline, and
/// anything else is the kernel refusing promptly, which is the answer we want.
fn probe_script(public: Option<&str>) -> String {
    let mut targets: Vec<(String, String, String)> = FENCED_ADDRESSES
        .iter()
        .map(|(h, p, l)| ((*h).to_string(), p.to_string(), (*l).to_string()))
        .collect();
    if let Some(target) = public {
        let (host, port) = split_host_port(target);
        targets.push((host.to_string(), port.to_string(), "public".to_string()));
    }
    probe_script_for(&targets)
}

/// The script body, over an arbitrary target list.
///
/// Split out from `probe_script` for one reason: it lets a test run this exact shell
/// against sockets it controls on the loopback interface, so the mapping from a connect
/// attempt to a `RESULT` line is executed rather than asserted. The fenced addresses are
/// constants on purpose, and a test that could not choose its own targets would have been a
/// test of the string and not of the shell.
fn probe_script_for(targets: &[(String, String, String)]) -> String {
    let mut s = format!(
        "probe() {{ timeout {PROBE_CONNECT_SECONDS} bash -c \"exec 3<>/dev/tcp/$1/$2\" \
         2>/dev/null; rc=$?; \
         if [ $rc -eq 0 ]; then echo \"RESULT $3 open\"; \
         elif [ $rc -eq 124 ]; then echo \"RESULT $3 hung\"; \
         else echo \"RESULT $3 blocked\"; fi; }}\n"
    );
    for (host, port, label) in targets {
        s.push_str(&format!("probe {host} {port} {label}\n"));
    }
    s
}

/// `host:port`, falling back to 443 when no port is given, because the only thing this
/// target is used for is opening a TCP connection to somewhere ordinary.
fn split_host_port(target: &str) -> (&str, &str) {
    match target.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => {
            (h, p)
        }
        _ => (target, "443"),
    }
}

fn parse_probe_output(stdout: &str) -> Vec<(String, Reach)> {
    let mut found = Vec::new();
    for line in stdout.lines() {
        let mut parts = line.split_whitespace();
        if parts.next() != Some("RESULT") {
            continue;
        }
        let (Some(label), Some(verdict)) = (parts.next(), parts.next()) else {
            continue;
        };
        let reach = match verdict {
            "open" => Reach::Open,
            "hung" => Reach::Hung,
            "blocked" => Reach::Blocked,
            _ => continue,
        };
        found.push((label.to_string(), reach));
    }
    found
}

/// Turn the probe container's output into a decision about whether to start.
///
/// Pure, and separate from the container that produces the input, so that the rule this
/// worker refuses to start on can be tested without a docker daemon. A control that only
/// runs on production hardware is a control whose logic nobody has ever seen execute, which
/// is the shape of the bug this whole function was written to close.
///
/// Every way of not being sure is a failure. A missing result, an unparseable one, a
/// connection that succeeded and a connection that hung all mean the same thing here: this
/// process cannot demonstrate that the fence holds, and the fence is the only boundary
/// between a customer's script and the host's credentials.
fn judge_egress(stdout: &str, public: Option<&str>) -> Result<Vec<String>, String> {
    let found = parse_probe_output(stdout);
    let get = |label: &str| found.iter().find(|(l, _)| l == label).map(|(_, r)| *r);
    let mut notes = Vec::new();

    for (host, port, label) in FENCED_ADDRESSES {
        match get(label) {
            Some(Reach::Blocked) => notes.push(format!("{host}:{port} refused, as it must be")),
            Some(Reach::Open) => {
                return Err(format!(
                    "a container on this network opened a connection to {host}:{port}; \
                     the {label} block is not in force"
                ))
            }
            Some(Reach::Hung) => {
                return Err(format!(
                    "a connection to {host}:{port} neither connected nor was refused within \
                     {PROBE_CONNECT_SECONDS}s; the fence REJECTs, so this is some other \
                     filter and not one this worker can rely on"
                ))
            }
            None => {
                return Err(format!(
                    "the probe container reported nothing for {host}:{port}, so the \
                     {label} block is unproven"
                ))
            }
        }
    }

    if let Some(target) = public {
        match get("public") {
            Some(Reach::Open) => {
                notes.push(format!("{target} reachable, so refusals mean refused"))
            }
            Some(other) => {
                return Err(format!(
                    "the positive control failed: {target} was {other:?} rather than reachable. \
                     Every blocked address above was refused, but so would every address be on \
                     a network with no route out, so the refusals prove nothing. Fix the \
                     network, or point KAVIRI_EGRESS_PROBE_PUBLIC at something this box can \
                     reach, or set it to off and accept that the fence is unverified"
                ))
            }
            None => {
                return Err(format!(
                    "the probe container reported nothing for the positive control {target}"
                ))
            }
        }
    }

    Ok(notes)
}

#[async_trait::async_trait]
impl RenderBackend for DockerBackend {
    fn name(&self) -> &'static str {
        "docker"
    }

    async fn preflight(&self) -> Result<(), String> {
        run_ok(&["version", "--format", "{{.Server.Version}}"]).await?;
        // Inspect rather than pull. A box that cannot see its own render image should say
        // so at startup, not discover it while holding a lease, and an automatic pull
        // would silently change what a take is filmed with.
        run_ok(&["image", "inspect", &self.image])
            .await
            .map_err(|e| {
                format!(
                    "render image {} is not present on this box: {e}",
                    self.image
                )
            })?;
        run_ok(&["network", "inspect", &self.network])
            .await
            .map_err(|e| {
                format!(
                    "docker network {} does not exist; create it with docker/egress.sh: {e}",
                    self.network
                )
            })?;

        // The network existing is not the control. The network is a docker object and
        // survives a reboot; the iptables rules that make it a fence do not, so a rebooted
        // box passes the inspect above with the only real boundary gone. This is why the
        // check below is a connection and not a lookup: it is the difference between
        // knowing the fence is configured and knowing it holds.
        self.verify_egress_fence().await?;

        // Chromium's sandbox is a second boundary inside the container one, and it is
        // worth keeping. It needs an unprivileged user namespace, which some hosts refuse
        // (AppArmor on Ubuntu 24.04 restricts them by default). Probing beats assuming in
        // both directions: assuming it works films every take with a broken browser, and
        // assuming it does not throws away a layer of defence on hosts that have it.
        let probe = run_capture(&[
            "run",
            "--rm",
            "--network",
            "none",
            "--user",
            &format!("{}:{}", self.uid, self.gid),
            "--entrypoint",
            "/usr/bin/unshare",
            &self.image,
            "-U",
            "true",
        ])
        .await;
        let ok = matches!(probe, Ok(ref out) if out.status_success);
        self.sandbox_available.store(ok, Ordering::Relaxed);
        if ok {
            tracing::info!("chromium sandbox: on (unprivileged user namespaces work on this host)");
        } else {
            tracing::warn!(
                "chromium sandbox: OFF. This host refuses unprivileged user namespaces, so takes \
                 run with --no-sandbox and the container is the only boundary around a customer's \
                 page. See docker/README.md."
            );
        }
        Ok(())
    }

    async fn run(
        &self,
        req: RenderRequest,
        progress: watch::Sender<Progress>,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<RenderOutcome, String> {
        let name = Self::container_name(&req.job_id);
        let started = std::time::Instant::now();

        let mut chromium = chromium_args();
        if !self.sandbox_available.load(Ordering::Relaxed) {
            chromium.push_str(" --no-sandbox");
        }

        let mem = self.memory.clone();
        let mut argv: Vec<String> = vec![
            "run".into(),
            "--rm".into(),
            // tini as pid 1, so the SIGTERM that truncates a take reaches the recorder and
            // so a Chromium that forks and dies does not leave zombies behind it.
            "--init".into(),
            "--name".into(),
            name.clone(),
            "--label".into(),
            format!("kaviri.job={}", req.job_id),
            "--label".into(),
            format!("kaviri.attempt={}", req.attempt),
            "--network".into(),
            self.network.clone(),
            "--user".into(),
            format!("{}:{}", self.uid, self.gid),
            "--cap-drop".into(),
            "ALL".into(),
            "--security-opt".into(),
            "no-new-privileges:true".into(),
            // The only writable paths are the two bind mounts and one small tmpfs. A
            // script that finds a way to write anywhere else is writing into a layer that
            // is discarded with the container.
            "--read-only".into(),
            "--tmpfs".into(),
            "/tmp:rw,nosuid,nodev,size=256m".into(),
            // Chromium puts its shared memory here and the Docker default of 64 MB is not
            // enough for a compositor pass at 2x on a large viewport.
            "--shm-size".into(),
            "1g".into(),
            "--memory".into(),
            mem.clone(),
            // Equal to --memory, which disables swap for the container. Swapping a take is
            // worse than failing it: the frames still arrive, the wall clock still runs,
            // and the video is a slideshow.
            "--memory-swap".into(),
            mem,
            "--cpus".into(),
            self.cpus.clone(),
            "--pids-limit".into(),
            "1024".into(),
            "--mount".into(),
            format!("type=bind,src={},dst=/work", req.host_dir.display()),
            "--mount".into(),
            format!("type=bind,src={},dst=/spool", req.host_spool.display()),
            "-e".into(),
            "HOME=/tmp".into(),
            "-e".into(),
            "XDG_CONFIG_HOME=/tmp".into(),
            "-e".into(),
            "XDG_CACHE_HOME=/tmp".into(),
            // The frame spool and the CFR intermediate both live under TMPDIR, and both
            // belong on the big disk rather than in the 256 MB tmpfs.
            "-e".into(),
            "TMPDIR=/spool".into(),
            "-e".into(),
            format!("KAVIRI_CHROMIUM_ARGS={chromium}"),
        ];
        for (k, v) in &req.env {
            argv.push("-e".into());
            argv.push(format!("{k}={v}"));
        }
        argv.push(self.image.clone());
        argv.push("record".into());
        argv.push("--script".into());
        argv.push(format!("/work/{SCRIPT_FILE}"));
        argv.push("--out".into());
        argv.push(format!("/work/{OUT_FILE}"));
        argv.push("--spool-dir".into());
        argv.push("/spool".into());
        argv.push("--max-spool-bytes".into());
        argv.push(req.max_spool_bytes.to_string());
        argv.extend(req.args.iter().cloned());

        let mut child = tokio::process::Command::new("docker")
            .args(&argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("cannot start docker: {e}"))?;

        let ok_count = Arc::new(Mutex::new(0usize));
        let failure: Arc<Mutex<Option<OpFailure>>> = Arc::new(Mutex::new(None));
        let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        if let Some(out) = child.stdout.take() {
            let ok_count = Arc::clone(&ok_count);
            let failure = Arc::clone(&failure);
            let progress = progress.clone();
            let total = req.total_ops;
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match read_recorder_line(&line) {
                        Some(RecorderLine::OpSucceeded) => {
                            let mut n = ok_count.lock().unwrap_or_else(|p| p.into_inner());
                            *n += 1;
                            // The recorder answers the start_recording it inserts itself
                            // before it answers the first real op, so the count of successes
                            // runs one ahead of the script until the take ends.
                            let done = n.saturating_sub(1).min(total);
                            let _ = progress.send(Progress {
                                ops_done: done,
                                phase: if done >= total {
                                    Phase::Rendering
                                } else {
                                    Phase::Filming
                                },
                            });
                        }
                        Some(RecorderLine::OpFailed(f)) => {
                            let mut slot = failure.lock().unwrap_or_else(|p| p.into_inner());
                            // The first failure is the one that ended the script; anything
                            // after it is fallout from the teardown.
                            if slot.is_none() {
                                *slot = Some(f);
                            }
                        }
                        None => {}
                    }
                }
            });
        }

        if let Some(err) = child.stderr.take() {
            let stderr_tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    // Redacted on the way in rather than on the way out, so there is no
                    // version of this buffer anywhere that holds a customer's URL.
                    let clean = redact::line_for_log(&line);
                    let mut tail = stderr_tail.lock().unwrap_or_else(|p| p.into_inner());
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.remove(0);
                    }
                    tail.push(clean);
                }
            });
        }

        let far_future = Instant::now() + Duration::from_secs(365 * 24 * 3600);
        let soft_at = Instant::now() + req.soft_deadline;
        let mut hard_at = far_future;
        let mut watchdog = tokio::time::interval(Duration::from_secs(5));
        watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let mut outcome = RenderOutcome::default();
        let mut stopping = false;
        let mut ladder = StopLadder::default();
        let disk_ceiling = job_disk_ceiling(req.max_spool_bytes, req.max_artifact_bytes);

        // A cancel that arrived before the container started still has to be honoured, and
        // watch::Receiver::changed only fires on a change after this point.
        if *cancel.borrow() {
            outcome.cancelled = true;
            stopping = true;
            spawn_stop(&name, 5);
            hard_at = Instant::now() + Duration::from_secs(30);
        }

        // `None` means the loop stopped waiting rather than the child exiting. That only
        // happens on the abandonment path below, and it is a separate value from an exit
        // status precisely so that no code after this point can mistake "we gave up" for
        // "it finished".
        let status: Option<std::process::ExitStatus> = loop {
            tokio::select! {
                // Biased so that a process which has already exited is reaped before any
                // timer fires, rather than being reported as killed because a deadline and
                // an exit landed in the same poll.
                biased;

                r = child.wait() => break Some(r.map_err(|e| format!("waiting for docker: {e}"))?),

                _ = tokio::time::sleep_until(soft_at), if !stopping => {
                    // The take is truncated rather than failed. SIGTERM reaches the
                    // recorder through tini, the recorder stops capture, renders what it
                    // has and exits non zero, and the customer gets a short video instead
                    // of nothing at all. docker stop sends SIGKILL after the grace period,
                    // which is the hard stop if the render itself hangs.
                    tracing::warn!(job = %req.job_id, "wall clock reached; truncating the take");
                    outcome.truncated = true;
                    stopping = true;
                    spawn_stop(&name, req.render_grace.as_secs());
                    hard_at = Instant::now() + req.render_grace + Duration::from_secs(30);
                }

                _ = cancel.changed(), if !stopping => {
                    if *cancel.borrow() {
                        // A cancel is not a truncation: the customer does not want the
                        // video, so the render pass is not worth the wall clock. Five
                        // seconds is enough for the browser to be closed cleanly.
                        tracing::info!(job = %req.job_id, "cancel requested; stopping the take");
                        outcome.cancelled = true;
                        stopping = true;
                        spawn_stop(&name, 5);
                        hard_at = Instant::now() + Duration::from_secs(30);
                    }
                }

                _ = watchdog.tick(), if !stopping => {
                    // The whole job directory, not just the spool. The spool is where the
                    // bytes arrive fastest, but it is not the only thing the container
                    // writes to this disk: take.mp4 is written into /work, and a watchdog
                    // that measures /spool alone is blind to it. Today the spool happens to
                    // be a subdirectory of the job directory, so measuring the job
                    // directory covers both, and the check below keeps that from being a
                    // silent assumption if a backend ever puts the spool elsewhere.
                    let work = req.host_dir.clone();
                    let spool = req.host_spool.clone();
                    let used = tokio::task::spawn_blocking(move || {
                        let mut total = dir_size(&work);
                        if !spool.starts_with(&work) {
                            total += dir_size(&spool);
                        }
                        total
                    })
                        .await
                        .unwrap_or(0);
                    if used > disk_ceiling {
                        tracing::warn!(
                            job = %req.job_id,
                            used_mib = used / (1024 * 1024),
                            ceiling_mib = disk_ceiling / (1024 * 1024),
                            "disk watchdog tripped"
                        );
                        outcome.spool_limit = true;
                        outcome.truncated = true;
                        stopping = true;
                        spawn_stop(&name, req.render_grace.as_secs());
                        hard_at = Instant::now() + req.render_grace + Duration::from_secs(30);
                    }
                }

                // Armed on `stopping` alone. It used to be armed on
                // `stopping && !outcome.killed`, which disabled this arm the instant the
                // first kill was *requested*, not when one succeeded. Since the kill is
                // spawned and its result is never looked at, a `docker kill` that failed
                // left the loop with no timer, no further escalation, and nothing to do but
                // wait on a child that was not going to exit, while the heartbeat in
                // job.rs kept renewing the lease so the reaper could not take the job back
                // either. One failed subprocess and the job was stuck for as long as the
                // worker lived.
                _ = tokio::time::sleep_until(hard_at), if stopping => {
                    outcome.killed = true;
                    match ladder.next() {
                        Escalation::Kill { attempt } => {
                            tracing::error!(
                                job = %req.job_id,
                                attempt,
                                of = MAX_KILL_ATTEMPTS,
                                "container did not stop; killing it"
                            );
                            spawn_kill(&name);
                            hard_at = Instant::now() + KILL_RETRY;
                        }
                        Escalation::Abandon => {
                            // Every way this worker has of ending the container has been
                            // tried and has not worked, so continuing to wait is just a
                            // slower way of never finishing. The container is left running
                            // and said so loudly, because a silent abandonment is worse
                            // than a noisy one: somebody has to go and look at this box.
                            //
                            // What makes this safe for the customer's job is what happens
                            // next in job.rs. The take is not reported. The heartbeat stops,
                            // the lease lapses, and the reaper gives the job to a box that
                            // works. That is the only recovery path that does not depend on
                            // this box being able to do anything, which is the right
                            // property for the case where this box has been shown not to be.
                            tracing::error!(
                                job = %req.job_id,
                                container = %name,
                                attempts = MAX_KILL_ATTEMPTS,
                                "docker kill did not end this container; abandoning it and \
                                 letting the lease lapse so another box films the take. This \
                                 box needs a human: the container is still running."
                            );
                            outcome.abandoned = true;
                            break None;
                        }
                    }
                }
            }
        };

        if outcome.abandoned {
            // Deliberately no `docker rm --force` here. The daemon has already failed to
            // kill this container, so the same call is not more likely to work, and
            // `docker rm` on a wedged daemon blocks, which would move the hang from the
            // select loop into the line that was supposed to end it.
            outcome.wall_seconds = started.elapsed().as_secs_f64();
            outcome.ops_completed = ok_count
                .lock()
                .map(|n| n.saturating_sub(1).min(req.total_ops))
                .unwrap_or(0);
            return Ok(outcome);
        }

        // Nothing here is load bearing for correctness, but a container that outlived its
        // docker run client holds a bind mount open, and the job directory is about to be
        // removed underneath it.
        let _ = run_capture(&["rm", "--force", &name]).await;

        outcome.exit_code = status.and_then(|s| s.code());
        outcome.wall_seconds = started.elapsed().as_secs_f64();
        outcome.ops_completed = ok_count
            .lock()
            .map(|n| n.saturating_sub(1).min(req.total_ops))
            .unwrap_or(0);
        outcome.failure = failure.lock().ok().and_then(|f| f.clone());
        outcome.stderr_tail = stderr_tail.lock().map(|t| t.join("\n")).unwrap_or_default();
        Ok(outcome)
    }

    async fn probe(&self, file: &Path) -> Result<MediaInfo, String> {
        let dir = file
            .parent()
            .ok_or("a file to probe must have a parent directory")?;
        let name = file
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("a file to probe must have a name")?;
        let out = run_capture(&[
            "run",
            "--rm",
            // The probe reads one local file. Nothing it could want is on the network, and
            // a malformed file that makes ffprobe reach out is not a thing we want to find
            // out about the hard way.
            "--network",
            "none",
            "--user",
            &format!("{}:{}", self.uid, self.gid),
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--read-only",
            "--mount",
            &format!("type=bind,src={},dst=/probe,readonly", dir.display()),
            "--entrypoint",
            "/usr/bin/ffprobe",
            &self.image,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=width,height",
            "-select_streams",
            "v:0",
            "-of",
            "json",
            &format!("/probe/{name}"),
        ])
        .await?;
        if !out.status_success {
            return Err(format!("ffprobe failed: {}", out.stderr.trim()));
        }
        let v: serde_json::Value = serde_json::from_str(&out.stdout)
            .map_err(|e| format!("ffprobe returned unparseable JSON: {e}"))?;
        let stream = v.get("streams").and_then(|s| s.get(0));
        Ok(MediaInfo {
            duration_seconds: v
                .get("format")
                .and_then(|f| f.get("duration"))
                .and_then(serde_json::Value::as_str)
                .and_then(|d| d.parse::<f64>().ok()),
            width: stream
                .and_then(|s| s.get("width"))
                .and_then(serde_json::Value::as_u64)
                .map(|n| n as u32),
            height: stream
                .and_then(|s| s.get("height"))
                .and_then(serde_json::Value::as_u64)
                .map(|n| n as u32),
        })
    }
}

/// What one line of the recorder's stdout means.
enum RecorderLine {
    OpSucceeded,
    OpFailed(OpFailure),
}

/// Interpret one line of the recorder's stdout.
///
/// A function rather than the body of the reader task, so the redaction on this path can be
/// tested at the line where it happens. That distinction earned itself: the redaction on the
/// *stderr* path had a test and the redaction on this path did not exist, and the shape of
/// that bug was precisely a path nobody could write a test against without a container.
///
/// The recorder's error text is redacted here, on the way in, exactly as the stderr reader
/// does it. Both fields need it and for the same reason. The recorder formats a navigate
/// failure as `navigate failed: {err}: {url}` with the URL whole, so a signed preview link's
/// query string used to travel through this field into the job error and come to rest in the
/// job row, which is durable and readable by everyone in the customer's org. The op name
/// needs it for a different reason: it is the customer's own string echoed back, so its
/// length is the customer's choice.
///
/// Redacting here costs nothing downstream. The only consumer that reads this text rather
/// than displaying it is `classify_op_failure`, which matches on `navigate`, `timed out` and
/// `timeout`, and the redactor rewrites URLs and quoted values while leaving ordinary words
/// where they are.
fn read_recorder_line(line: &str) -> Option<RecorderLine> {
    let v = serde_json::from_str::<serde_json::Value>(line).ok()?;
    match v.get("ok").and_then(serde_json::Value::as_bool) {
        Some(true) => Some(RecorderLine::OpSucceeded),
        Some(false) => Some(RecorderLine::OpFailed(OpFailure {
            index: v
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as usize,
            op: redact::token_for_log(
                v.get("op")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("?"),
                OP_NAME_IN_ERROR,
            ),
            error: redact::line_for_log(
                v.get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
            ),
        })),
        _ => None,
    }
}

/// What to do the next time a container that was asked to stop has still not stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Escalation {
    Kill { attempt: u32 },
    Abandon,
}

/// How far along the stop ladder one container is.
///
/// A type of its own, and the state machine's only memory of how many kills have been
/// tried, because the bug it replaces came from inferring that from `outcome.killed`. That
/// flag answers "was a kill ever requested", the loop needed "how many have been tried",
/// and the two questions have the same answer exactly once.
///
/// Note what this deliberately does not do: it does not look at whether `docker kill`
/// succeeded. The kill is spawned so the loop stays free to reap the child, and its result
/// is therefore not available at the point the next decision has to be made. The only
/// evidence that matters is the one the loop already has, which is that the child is still
/// running, so the ladder counts attempts and ends.
#[derive(Debug, Default)]
struct StopLadder {
    kills: u32,
}

impl StopLadder {
    fn next(&mut self) -> Escalation {
        if self.kills >= MAX_KILL_ATTEMPTS {
            return Escalation::Abandon;
        }
        self.kills += 1;
        Escalation::Kill {
            attempt: self.kills,
        }
    }
}

/// The most this job may have on disk before the watchdog stops it.
///
/// Three terms, because there are three writers. The recorder's own frame spool cap is the
/// first, the CFR intermediate that lands under the same TMPDIR and is not counted against
/// that cap is the overshoot allowance, and the finished MP4 is the artifact ceiling, which
/// is already the largest file this worker will agree to upload. Adding the artifact term
/// rather than folding it into the overshoot matters: without it, counting the job
/// directory instead of the spool would have made a legitimate two gigabyte video eat the
/// intermediate's headroom and stop takes that were inside every configured limit.
fn job_disk_ceiling(max_spool_bytes: u64, max_artifact_bytes: u64) -> u64 {
    max_spool_bytes
        .saturating_mul(SPOOL_OVERSHOOT_NUMERATOR)
        .saturating_div(SPOOL_OVERSHOOT_DENOMINATOR)
        .saturating_add(max_artifact_bytes)
}

/// Ask the container to stop, from a task of its own.
///
/// Spawned rather than awaited in place because `docker stop` blocks for the whole grace
/// period, and the loop that called it is the only thing still reaping the child, noticing
/// a cancel and watching the spool.
fn spawn_stop(name: &str, grace_seconds: u64) {
    let name = name.to_string();
    tokio::spawn(async move {
        let _ = run_capture(&["stop", "--time", &grace_seconds.to_string(), &name]).await;
    });
}

fn spawn_kill(name: &str) {
    let name = name.to_string();
    tokio::spawn(async move {
        let _ = run_capture(&["kill", &name]).await;
    });
}

struct Captured {
    status_success: bool,
    stdout: String,
    stderr: String,
}

async fn run_capture(args: &[&str]) -> Result<Captured, String> {
    let out = tokio::process::Command::new("docker")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("cannot run docker: {e}"))?;
    Ok(Captured {
        status_success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

async fn run_ok(args: &[&str]) -> Result<(), String> {
    let out = run_capture(args).await?;
    if out.status_success {
        Ok(())
    } else {
        Err(out.stderr.trim().chars().take(300).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn the_disk_ceiling_leaves_room_for_the_intermediate_and_for_one_video() {
        let cap = 8 * GIB;
        let artifact = 2 * GIB;
        let ceiling = job_disk_ceiling(cap, artifact);
        assert_eq!(ceiling, cap + cap / 4 + artifact);
        assert!(
            ceiling > cap,
            "the watchdog must not fire before the recorder's own cap"
        );
        // The watchdog now measures the job directory, which holds the finished MP4 as well
        // as the spool. A take that spools right up to its cap and then renders the largest
        // video this worker would upload must still be inside the ceiling, or the fix for
        // the blind spot would have turned into a new way to fail a legitimate take.
        assert!(cap + artifact < ceiling);
    }

    #[test]
    fn the_stop_ladder_escalates_every_time_and_then_gives_up() {
        // This is the regression test for the hang. The old guard was
        // `stopping && !outcome.killed`, so the second tick found the arm disabled and the
        // loop waited on the child forever. The ladder must answer every time it is asked.
        let mut ladder = StopLadder::default();
        for attempt in 1..=MAX_KILL_ATTEMPTS {
            assert_eq!(ladder.next(), Escalation::Kill { attempt });
        }
        // And then it must stop answering "kill", or the retry is its own infinite loop.
        for _ in 0..10 {
            assert_eq!(
                ladder.next(),
                Escalation::Abandon,
                "once the kills are spent the answer is abandonment, and it stays that way"
            );
        }
    }

    #[test]
    fn a_fenced_network_passes_and_every_other_answer_does_not() {
        let good = "RESULT metadata blocked\nRESULT rfc1918 blocked\nRESULT public open\n";
        assert!(judge_egress(good, Some("1.1.1.1:443")).is_ok());

        // The failure this whole probe exists to catch: a rebooted box whose docker network
        // is intact and whose iptables rules are gone.
        let unfenced = "RESULT metadata open\nRESULT rfc1918 open\nRESULT public open\n";
        let err = judge_egress(unfenced, Some("1.1.1.1:443")).unwrap_err();
        assert!(err.contains("169.254.169.254"), "{err}");
        assert!(err.contains("not in force"), "{err}");

        // A half configured box: the famous address is blocked and the rest of the ranges
        // are not. A probe that only ever tried 169.254.169.254 would call this fine.
        let partial = "RESULT metadata blocked\nRESULT rfc1918 open\nRESULT public open\n";
        assert!(judge_egress(partial, Some("1.1.1.1:443")).is_err());

        // A DROP rule somewhere else is not the fence we install and is not relied on.
        let dropped = "RESULT metadata hung\nRESULT rfc1918 blocked\nRESULT public open\n";
        assert!(judge_egress(dropped, Some("1.1.1.1:443")).is_err());

        // Silence is not consent. An empty or truncated probe fails closed.
        assert!(judge_egress("", Some("1.1.1.1:443")).is_err());
        assert!(judge_egress("RESULT metadata blocked\n", Some("1.1.1.1:443")).is_err());
        assert!(judge_egress("bash: /bin/bash: not found\n", None).is_err());
    }

    #[test]
    fn the_positive_control_is_what_stops_a_dead_network_from_looking_fenced() {
        // Nothing is reachable from this container, so every fenced address is refused and
        // the negative checks all pass. Without the positive control the worker would start
        // and believe its fence had been verified.
        let dead = "RESULT metadata blocked\nRESULT rfc1918 blocked\nRESULT public blocked\n";
        let err = judge_egress(dead, Some("1.1.1.1:443")).unwrap_err();
        assert!(err.contains("positive control"), "{err}");
        // Turned off explicitly, the same output is accepted, which is the tradeoff the
        // operator opted into and the reason the worker warns about it at startup.
        assert!(judge_egress(dead, None).is_ok());
    }

    #[test]
    fn the_probe_script_asks_about_every_address_the_judge_requires() {
        let script = probe_script(Some("198.51.100.7:8443"));
        for (host, _, label) in FENCED_ADDRESSES {
            assert!(script.contains(host), "{host} is judged but never probed");
            assert!(script.contains(label));
        }
        assert!(script.contains("probe 198.51.100.7 8443 public"));
        assert!(script.contains("timeout 5 bash"));
        // No positive control configured means no line for it, and judge_egress then does
        // not look for one.
        assert!(!probe_script(None).contains(" public"));
    }

    /// Run the real probe shell against sockets this test owns.
    ///
    /// This is the half of the fence check that cannot be reasoned about from the source:
    /// whether `timeout`, bash's `/dev/tcp` and the exit code arithmetic actually produce
    /// the `RESULT` lines `judge_egress` is written to read. It runs on the host rather
    /// than in a container, which is a real difference and an acceptable one, because the
    /// container adds a network namespace and changes nothing about the shell.
    ///
    /// Only `open` and `blocked` are exercised. They are the two that carry the security
    /// decision, since `open` on a fenced address is exactly the rebooted box this whole
    /// probe exists to catch. `hung` needs a blackholed route, which is not something a
    /// test can create without root, so its handling is covered where it can be: in
    /// `judge_egress`, which treats it as a failure.
    #[test]
    fn the_probe_shell_really_does_tell_a_listening_port_from_a_closed_one() {
        use std::net::TcpListener;

        let Ok(listening) = TcpListener::bind("127.0.0.1:0") else {
            eprintln!("skipped: cannot bind loopback in this environment");
            return;
        };
        let open_port = listening.local_addr().unwrap().port();

        // Bound and dropped, so the port is almost certainly free and a connection to it is
        // refused promptly, which is what the fence's REJECT looks like from inside a
        // container.
        let closed_port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let p = l.local_addr().unwrap().port();
            drop(l);
            p
        };

        let targets = vec![
            (
                "127.0.0.1".to_string(),
                open_port.to_string(),
                "listening".to_string(),
            ),
            (
                "127.0.0.1".to_string(),
                closed_port.to_string(),
                "shut".to_string(),
            ),
        ];

        let out = match std::process::Command::new("bash")
            .arg("-c")
            .arg(probe_script_for(&targets))
            .output()
        {
            Ok(o) => o,
            Err(e) => {
                eprintln!("skipped: no bash to run the probe with: {e}");
                return;
            }
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        let parsed = parse_probe_output(&stdout);

        assert_eq!(
            parsed,
            vec![
                ("listening".to_string(), Reach::Open),
                ("shut".to_string(), Reach::Blocked),
            ],
            "the probe shell produced {stdout:?}"
        );
        drop(listening);
    }

    #[test]
    fn a_probe_target_without_a_port_still_names_one() {
        assert_eq!(split_host_port("1.1.1.1:443"), ("1.1.1.1", "443"));
        assert_eq!(split_host_port("example.test"), ("example.test", "443"));
        // A trailing colon or a non numeric port is a typo, not a port, and guessing 443 is
        // better than building a probe line the shell would mangle.
        assert_eq!(split_host_port("example.test:"), ("example.test:", "443"));
    }

    /// Fed the exact line the recorder writes to stdout, through the exact function the
    /// reader task uses. `kaviri/src/ops.rs` formats a navigate failure as
    /// `navigate failed: {err}: {url}`, with the URL whole, and this is the path that used
    /// to carry it into the job row untouched while the stderr path beside it was cleaned.
    #[test]
    fn a_recorder_failure_line_does_not_carry_a_signed_urls_query_string() {
        let line = serde_json::json!({
            "ok": false,
            "index": 7,
            "op": "navigate",
            "error": "navigate failed: timed out after 25s: \
                      https://app.example.com/preview/deadbeef?X-Amz-Signature=cafebabe"
        })
        .to_string();

        let Some(RecorderLine::OpFailed(f)) = read_recorder_line(&line) else {
            panic!("a line with ok:false is an op failure");
        };

        assert_eq!(f.index, 7);
        assert!(!f.error.contains("cafebabe"), "{}", f.error);
        assert!(!f.error.contains("deadbeef"), "{}", f.error);
        // The host survives, because "the page would not load" and "which page" are the two
        // things an on call engineer needs and neither is the secret.
        assert!(f.error.contains("app.example.com"), "{}", f.error);
        // The classifier reads this same text, so redacting it must not change the code the
        // customer is given.
        assert_eq!(
            crate::script::classify_op_failure(&f.error),
            "navigate_timeout"
        );
    }

    #[test]
    fn an_op_name_echoed_back_by_the_recorder_cannot_be_a_megabyte() {
        let line = serde_json::json!({
            "ok": false,
            "index": 1,
            "op": "q".repeat(500_000),
            "error": "something went wrong"
        })
        .to_string();
        let Some(RecorderLine::OpFailed(f)) = read_recorder_line(&line) else {
            panic!("a line with ok:false is an op failure");
        };
        assert!(f.op.chars().count() < 100, "{} chars", f.op.chars().count());
        assert!(f.op.starts_with("qqq"));
    }

    #[test]
    fn a_successful_op_line_and_a_line_that_is_not_json_are_told_apart() {
        assert!(matches!(
            read_recorder_line(r#"{"ok":true,"index":1}"#),
            Some(RecorderLine::OpSucceeded)
        ));
        // Chromium writes plenty to stdout that is not ours. It must not be counted as
        // progress and must not be counted as a failure.
        assert!(read_recorder_line("[1234:5678] some chromium noise").is_none());
        assert!(read_recorder_line(r#"{"level":"info"}"#).is_none());
    }

    #[test]
    fn a_container_is_named_after_its_job_so_a_stuck_box_can_be_read_by_a_human() {
        let n = DockerBackend::container_name("4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44");
        assert!(n.starts_with("kaviri-job-"));
        assert!(n.contains("4a2c1f9e"));
    }
}
