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

pub struct DockerBackend {
    image: String,
    network: String,
    memory: String,
    cpus: String,
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
            uid: meta.uid(),
            gid: meta.gid(),
            sandbox_available: AtomicBool::new(false),
        })
    }

    fn container_name(job_id: &str) -> String {
        format!("kaviri-job-{job_id}")
    }
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
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                        continue;
                    };
                    if v.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
                        let mut n = ok_count.lock().unwrap_or_else(|p| p.into_inner());
                        *n += 1;
                        // The recorder answers the start_recording it inserts itself before
                        // it answers the first real op, so the count of successes runs one
                        // ahead of the script until the take ends.
                        let done = n.saturating_sub(1).min(total);
                        let _ = progress.send(Progress {
                            ops_done: done,
                            phase: if done >= total {
                                Phase::Rendering
                            } else {
                                Phase::Filming
                            },
                        });
                    } else if v.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
                        let index = v
                            .get("index")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0) as usize;
                        let op = v
                            .get("op")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        let error = v
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let mut slot = failure.lock().unwrap_or_else(|p| p.into_inner());
                        // The first failure is the one that ended the script; anything
                        // after it is fallout from the teardown.
                        if slot.is_none() {
                            *slot = Some(OpFailure { index, op, error });
                        }
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
        let spool_ceiling = req
            .max_spool_bytes
            .saturating_mul(SPOOL_OVERSHOOT_NUMERATOR)
            / SPOOL_OVERSHOOT_DENOMINATOR;

        // A cancel that arrived before the container started still has to be honoured, and
        // watch::Receiver::changed only fires on a change after this point.
        if *cancel.borrow() {
            outcome.cancelled = true;
            stopping = true;
            spawn_stop(&name, 5);
            hard_at = Instant::now() + Duration::from_secs(30);
        }

        let status = loop {
            tokio::select! {
                // Biased so that a process which has already exited is reaped before any
                // timer fires, rather than being reported as killed because a deadline and
                // an exit landed in the same poll.
                biased;

                r = child.wait() => break r.map_err(|e| format!("waiting for docker: {e}"))?,

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
                    let spool = req.host_spool.clone();
                    let used = tokio::task::spawn_blocking(move || dir_size(&spool))
                        .await
                        .unwrap_or(0);
                    if used > spool_ceiling {
                        tracing::warn!(
                            job = %req.job_id,
                            used_mib = used / (1024 * 1024),
                            ceiling_mib = spool_ceiling / (1024 * 1024),
                            "spool watchdog tripped"
                        );
                        outcome.spool_limit = true;
                        outcome.truncated = true;
                        stopping = true;
                        spawn_stop(&name, req.render_grace.as_secs());
                        hard_at = Instant::now() + req.render_grace + Duration::from_secs(30);
                    }
                }

                _ = tokio::time::sleep_until(hard_at), if stopping && !outcome.killed => {
                    tracing::error!(job = %req.job_id, "container did not stop; killing it");
                    outcome.killed = true;
                    spawn_kill(&name);
                    hard_at = Instant::now() + Duration::from_secs(30);
                }
            }
        };

        // Nothing here is load bearing for correctness, but a container that outlived its
        // docker run client holds a bind mount open, and the job directory is about to be
        // removed underneath it.
        let _ = run_capture(&["rm", "--force", &name]).await;

        outcome.exit_code = status.code();
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

    #[test]
    fn the_spool_ceiling_leaves_room_for_the_intermediate_and_no_more() {
        let cap = 8u64 * 1024 * 1024 * 1024;
        let ceiling = cap * SPOOL_OVERSHOOT_NUMERATOR / SPOOL_OVERSHOOT_DENOMINATOR;
        assert_eq!(ceiling, cap + cap / 4);
        assert!(
            ceiling > cap,
            "the watchdog must not fire before the recorder's own cap"
        );
    }

    #[test]
    fn a_container_is_named_after_its_job_so_a_stuck_box_can_be_read_by_a_human() {
        let n = DockerBackend::container_name("4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44");
        assert!(n.starts_with("kaviri-job-"));
        assert!(n.contains("4a2c1f9e"));
    }
}
