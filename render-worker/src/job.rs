//! One take, from lease to artifact.
//!
//! The order of operations is the part worth reading. Upload, then report: the artifact
//! row and the state change happen in one transaction inside `complete_job`, so there is
//! no instant at which a customer can poll a job that says `done` and find nothing behind
//! the download link. Everything before that point is recoverable by the reaper, because a
//! worker that dies here has simply stopped heartbeating.

use crate::backend::{
    MediaInfo, Phase, Progress, RenderBackend, RenderRequest, OUT_FILE, SCRIPT_FILE, TELEMETRY_FILE,
};
use crate::config::Config;
use crate::control::{job_error, ArtifactRef, Control, ControlError, Lease, Outcome};
use crate::redact;
use crate::script;
use crate::storage::Storage;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::watch;

/// A video shorter than this is not a take. The recorder will happily render a fraction of
/// a second of footage when the page it was pointed at failed to load, and handing that to
/// a customer as a finished demo is worse than telling them it failed.
const MIN_USABLE_SECONDS: f64 = 0.4;

pub struct Runner {
    pub cfg: Arc<Config>,
    pub control: Arc<Control>,
    pub storage: Arc<Storage>,
    pub backend: Arc<dyn RenderBackend>,
    /// Set when this box has been shown to be broken in a way that outlives the job that
    /// discovered it, which today means a container it could not kill.
    ///
    /// The lease loop reads it and stops taking work. That matters because the alternative
    /// is a box that has already proved it cannot end a container cheerfully leasing the
    /// next customer's take onto the same wedged daemon, with a runaway container still
    /// holding its disk. Exiting lets systemd restart the worker, and the restart re runs
    /// preflight, which is where a daemon in that state is caught properly.
    pub unhealthy: Arc<AtomicBool>,
}

impl Runner {
    /// Run one leased job to a terminal state.
    ///
    /// Returns nothing, because there is nothing for the caller to do with the result: the
    /// outcome has already been reported to the queue, and a failure to report it is a
    /// failure the reaper handles by giving the job to another box.
    pub async fn run(&self, lease: Lease) {
        let started = Instant::now();
        let job_id = lease.job_id.clone();
        let dir = self.cfg.job_dir(&job_id);
        let spool = dir.join("spool");

        let result = self.run_inner(&lease, started).await;

        // The job directory holds the customer's script and their video. It is removed
        // whatever happened, including on the paths that failed before the container
        // started, because leaving it is leaving customer data on a disk with no row
        // pointing at it and nothing scheduled to notice.
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::error!(job = %job_id, error = %e, "could not remove the job directory");
            }
        }
        let _ = tokio::fs::remove_dir_all(&spool).await;

        match result {
            Ok(state) => tracing::info!(
                job = %job_id,
                state = %state,
                seconds = started.elapsed().as_secs_f64(),
                "job finished"
            ),
            // A lost lease is expected rather than exceptional: the reaper decided this
            // box was gone, and another one either has the job or will. Saying anything
            // further about it would be a lie about a take we no longer own.
            Err(ControlError::LeaseLost(m)) => {
                tracing::warn!(job = %job_id, reason = %m, "lease lost; another box owns this job now")
            }
            // Deliberately louder than a lost lease, which is routine. This one means a
            // container is still running on this box with nothing left that can stop it,
            // and the job was handed back by silence rather than by a report.
            Err(ControlError::Abandoned(m)) => tracing::error!(
                job = %job_id,
                reason = %m,
                "job abandoned; the lease will lapse and the reaper will requeue it. This box \
                 has stopped taking work and needs a human."
            ),
            Err(e) => tracing::error!(job = %job_id, error = %e, "could not report the outcome"),
        }
    }

    async fn run_inner(&self, lease: &Lease, started: Instant) -> Result<String, ControlError> {
        let job_id = lease.job_id.clone();
        let token = lease.lease_token.clone();
        let dir = self.cfg.job_dir(&job_id);
        let spool = dir.join("spool");

        // ---- everything that can be refused before a box is spent ----

        let ops = match lease.ops() {
            Ok(o) => o.clone(),
            Err(e) => {
                return self
                    .reject(lease, "script_invalid", &e, None, started)
                    .await
            }
        };
        let prepared = match script::prepare(&ops) {
            Ok(p) => p,
            Err(r) => {
                return self
                    .reject(
                        lease,
                        "script_invalid",
                        &r.reason,
                        Some(json!({"op_index": r.op_index})),
                        started,
                    )
                    .await
            }
        };
        let options = match crate::options::resolve(&lease.options) {
            Ok(o) => o,
            Err(e) => {
                return self
                    .reject(lease, "options_invalid", &e, None, started)
                    .await
            }
        };

        tracing::info!(
            job = %job_id,
            project = %lease.project_id,
            attempt = lease.attempt,
            // The shape of the script, never the script. A demo that logs in has a
            // password in it, and this line is the one that would carry it.
            shape = %redact::script_shape(&prepared.ops),
            "leased"
        );

        // Checked here and not only at startup. The startup check answers "was this box
        // ever ready", which a long lived worker stops being able to answer honestly within
        // hours: a take spools at roughly 15 to 25 MB per second, an abandoned container or
        // a co-tenant can eat the disk between two jobs, and the failure of filming into a
        // full disk is not a clean one. It is a truncated MP4, a half written spool and
        // usually the next two jobs as well. Handing the take back before the container
        // starts costs the customer a requeue and costs this box nothing.
        let work_root = self.cfg.work_root.clone();
        let free = tokio::task::spawn_blocking(move || crate::free_bytes(&work_root))
            .await
            .unwrap_or_else(|e| Err(format!("the free space check panicked: {e}")));
        match free {
            Ok(free) if free < self.cfg.min_free_bytes => {
                return self
                    .fail_retryable(
                        lease,
                        "render_failed",
                        &format!(
                            "{} has {} MiB free and a take needs at least {} MiB",
                            self.cfg.work_root.display(),
                            free / (1024 * 1024),
                            self.cfg.min_free_bytes / (1024 * 1024)
                        ),
                        started,
                    )
                    .await;
            }
            Ok(_) => {}
            // Not knowing how much disk is left is not a reason to refuse a take. The
            // watchdog still bounds what this job can write, so the worst case here is the
            // behaviour we had before this check existed.
            Err(e) => tracing::warn!(job = %job_id, error = %e, "could not measure free disk"),
        }

        if let Err(e) = tokio::fs::create_dir_all(&spool).await {
            // A box that cannot make a directory is a broken box, not a broken take, so
            // this is retryable and the job goes back to the queue for somebody else.
            return self
                .fail_retryable(
                    lease,
                    "render_failed",
                    &format!("cannot prepare the job directory: {e}"),
                    started,
                )
                .await;
        }
        if let Err(e) = tokio::fs::write(dir.join(SCRIPT_FILE), &prepared.ndjson).await {
            return self
                .fail_retryable(
                    lease,
                    "render_failed",
                    &format!("cannot write the script: {e}"),
                    started,
                )
                .await;
        }

        // ---- the take ----

        self.control
            .report_progress(
                &job_id,
                &token,
                0.02,
                "starting the browser",
                Some("running"),
            )
            .await?;

        let (progress_tx, progress_rx) = watch::channel(Progress::default());
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let lease_lost = Arc::new(AtomicBool::new(false));

        let heartbeat = self.spawn_heartbeat(
            job_id.clone(),
            token.clone(),
            progress_rx,
            cancel_tx,
            Arc::clone(&lease_lost),
            prepared.ops.clone(),
        );

        let mut env: Vec<(String, String)> = Vec::new();
        if options.telemetry {
            env.push(("KAVIRI_TELEMETRY".into(), format!("/work/{TELEMETRY_FILE}")));
        } else {
            // Explicitly off rather than merely not on. The sidecar carries every navigate
            // URL verbatim, including query strings, and the default must not depend on a
            // recorder flag somebody adds later.
            env.push(("KAVIRI_TELEMETRY".into(), "0".into()));
        }

        // The lease carries the org's per job ceiling, which already has the platform
        // ceiling folded in. The worker clamps its own on top, because this number is the
        // only thing standing between one pathological script and a box held forever, and
        // it should not depend on a row being right.
        let budget = (lease.max_job_seconds.max(1) as u64).min(self.cfg.job_seconds_cap);

        let request = RenderRequest {
            job_id: job_id.clone(),
            attempt: lease.attempt,
            host_dir: dir.clone(),
            host_spool: spool.clone(),
            args: options.args,
            env,
            total_ops: prepared.ops.len(),
            soft_deadline: Duration::from_secs(budget),
            render_grace: self.cfg.render_grace,
            max_spool_bytes: self.cfg.max_spool_bytes,
            max_artifact_bytes: self.cfg.max_artifact_bytes,
        };

        let outcome = self.backend.run(request, progress_tx, cancel_rx).await;
        // Aborting the heartbeat here is what makes the abandonment path below work, and it
        // is worth naming: stopping the beat is the worker's only way to hand a job back
        // when it can no longer do anything about it, because the lease lapsing is the one
        // recovery mechanism that does not require this box to function.
        heartbeat.abort();

        if lease_lost.load(Ordering::Relaxed) {
            return Err(ControlError::LeaseLost(
                "the heartbeat was refused mid take".into(),
            ));
        }

        let outcome = match outcome {
            Ok(o) => o,
            Err(e) => {
                return self
                    .fail_retryable(
                        lease,
                        "render_failed",
                        &format!("the render backend failed: {e}"),
                        started,
                    )
                    .await
            }
        };

        if outcome.abandoned {
            // No complete_job, and the omission is the point. A container this worker could
            // not kill may still be filming, still writing to the bind mount and still
            // holding the box's CPU. Reporting `failed` would end a take that has not
            // ended, and reporting anything at all would refresh the lease and keep the
            // reaper away from the one job that needs it. Saying nothing lets the lease
            // lapse, which requeues the take on a box that works.
            self.unhealthy.store(true, Ordering::Relaxed);
            return Err(ControlError::Abandoned(format!(
                "the render container for this job could not be stopped on {}",
                self.cfg.worker_id
            )));
        }

        // ---- what came out of it ----

        let video = dir.join(OUT_FILE);
        let media = self.usable_video(&video).await;

        if outcome.cancelled {
            // A cancelled take keeps no artifact. The customer asked for it to stop, and a
            // half finished video they did not ask for costs them storage against their
            // own limit.
            self.control
                .complete_job(
                    &job_id,
                    &token,
                    Outcome::Cancelled,
                    started.elapsed().as_secs_f64(),
                    &[],
                    None,
                )
                .await?;
            return Ok("cancelled".into());
        }

        let (code, message, retryable) = classify(&outcome, media.is_some(), budget);

        if code.is_none() {
            // A finished take, including one the wall clock cut short. Truncation is not a
            // failure: the assignment for the supervisor is to render what it has, and
            // what it has is a real video of a real session. The final progress message is
            // where the customer is told it was cut, since a done job carries no error.
            let msg = if outcome.truncated {
                format!("truncated at the {budget}s wall clock limit and rendered")
            } else {
                "uploading".to_string()
            };
            self.control
                .report_progress(&job_id, &token, 0.97, &msg, Some("uploading"))
                .await?;

            let mut artifacts = Vec::new();
            match self
                .upload_video(
                    &lease.org_id,
                    &job_id,
                    lease.artifact_retention_days,
                    &video,
                    media.unwrap_or_default(),
                )
                .await
            {
                Ok(a) => artifacts.push(a),
                Err(e) => {
                    return self
                        .fail_retryable(lease, "upload_failed", &e, started)
                        .await;
                }
            }
            if options.telemetry {
                let path = dir.join(TELEMETRY_FILE);
                match self
                    .upload_telemetry(&lease.org_id, &job_id, lease.artifact_retention_days, &path)
                    .await
                {
                    Ok(Some(a)) => artifacts.push(a),
                    Ok(None) => {}
                    // The sidecar is a debugging extra. Losing it must not lose the video,
                    // which is the thing the customer actually asked for.
                    Err(e) => {
                        tracing::warn!(job = %job_id, error = %e, "the telemetry sidecar did not upload")
                    }
                }
            }

            self.control
                .complete_job(
                    &job_id,
                    &token,
                    Outcome::Done,
                    started.elapsed().as_secs_f64(),
                    &artifacts,
                    None,
                )
                .await?;
            return Ok("done".into());
        }

        // ---- a failure ----

        let code = code.expect("checked above");
        let mut detail = json!({
            "ops_completed": outcome.ops_completed,
            "exit_code": outcome.exit_code,
        });
        if let Some(f) = &outcome.failure {
            detail["op_index"] = json!(f.index);
            detail["op"] = json!(f.op);
        }
        if !outcome.stderr_tail.is_empty() {
            // Already redacted on the way into the buffer. It is here because "the browser
            // would not start" and "the browser started and the page 500ed" are the same
            // job state and different problems.
            detail["recorder_stderr"] = json!(outcome.stderr_tail);
        }

        // A partial video is uploaded only when this attempt is the last word. Attaching
        // one to a job that is about to be retried would put an artifact row on a queued
        // job, and the retry would overwrite it anyway.
        let final_attempt = !retryable || lease.attempt >= lease.max_attempts;
        let mut artifacts = Vec::new();
        if final_attempt {
            if let Some(info) = media {
                match self
                    .upload_video(
                        &lease.org_id,
                        &job_id,
                        lease.artifact_retention_days,
                        &video,
                        info,
                    )
                    .await
                {
                    Ok(a) => artifacts.push(a),
                    Err(e) => {
                        tracing::warn!(job = %job_id, error = %e, "the partial video did not upload")
                    }
                }
            }
        }

        self.control
            .complete_job(
                &job_id,
                &token,
                Outcome::Failed,
                started.elapsed().as_secs_f64(),
                &artifacts,
                Some(job_error(code, &message, retryable, Some(detail))),
            )
            .await?;
        Ok(format!("failed ({code})"))
    }

    /// A take we will not film, reported without spending a container on it.
    async fn reject(
        &self,
        lease: &Lease,
        code: &str,
        message: &str,
        detail: Option<Value>,
        started: Instant,
    ) -> Result<String, ControlError> {
        // Bounded, because most rejection messages are static but not all of them: the
        // script_invalid ones quote the customer's own op name, and the length of that is
        // the customer's choice. The quoting is bounded at its source in script.rs too;
        // this is the second bound, at the point where the string becomes a log line,
        // because that is the site a future caller with a new message will reach for.
        tracing::warn!(
            job = %lease.job_id,
            code,
            "refusing the job: {}",
            redact::token_for_log(message, 300)
        );
        self.control
            .complete_job(
                &lease.job_id,
                &lease.lease_token,
                Outcome::Failed,
                started.elapsed().as_secs_f64(),
                &[],
                // Never retryable. The same script will be just as wrong on the next box.
                Some(job_error(code, message, false, detail)),
            )
            .await?;
        Ok(format!("rejected ({code})"))
    }

    /// Something about this box went wrong. Hand the job back and let the queue give it to
    /// somebody else, or to this box again after the backoff.
    async fn fail_retryable(
        &self,
        lease: &Lease,
        code: &str,
        message: &str,
        started: Instant,
    ) -> Result<String, ControlError> {
        tracing::error!(job = %lease.job_id, code, "handing the job back: {message}");
        let done = self
            .control
            .complete_job(
                &lease.job_id,
                &lease.lease_token,
                Outcome::Failed,
                started.elapsed().as_secs_f64(),
                &[],
                Some(job_error(code, message, true, None)),
            )
            .await?;
        // The queue decides whether there is an attempt left, not the worker, so the state
        // it came back with is the one worth logging: `queued` means somebody will film
        // this again, and `failed` means the attempts are spent.
        tracing::info!(
            job = %lease.job_id,
            state = %done.state,
            retry_at = done.retry_at.as_deref().unwrap_or("none"),
            "the queue decided what happens next"
        );
        Ok(format!(
            "returned to the queue ({code}, now {})",
            done.state
        ))
    }

    /// Whether what the recorder left behind is a video worth uploading.
    async fn usable_video(&self, path: &std::path::Path) -> Option<MediaInfo> {
        let meta = tokio::fs::metadata(path).await.ok()?;
        if !meta.is_file() || meta.len() == 0 {
            return None;
        }
        if meta.len() > self.cfg.max_artifact_bytes {
            tracing::error!(
                bytes = meta.len(),
                "the take is larger than the artifact ceiling and will not be uploaded"
            );
            return None;
        }
        let info = self.backend.probe(path).await.ok()?;
        match info.duration_seconds {
            Some(d) if d >= MIN_USABLE_SECONDS => Some(info),
            // A file with no duration is a file ffprobe could not read, which means the
            // encode did not finish. Neither is a take.
            _ => None,
        }
    }

    async fn upload_video(
        &self,
        org_id: &str,
        job_id: &str,
        retention_days: Option<i32>,
        path: &std::path::Path,
        info: MediaInfo,
    ) -> Result<ArtifactRef, String> {
        let key = Storage::key_for(org_id, job_id, retention_days, "video", "mp4");
        let stored = self.storage.put_file(&key, path, "video/mp4").await?;
        Ok(ArtifactRef {
            kind: "video",
            storage_key: stored.storage_key,
            content_type: "video/mp4".into(),
            bytes: stored.bytes,
            sha256: stored.sha256_hex,
            duration_seconds: info.duration_seconds,
            width: info.width,
            height: info.height,
        })
    }

    async fn upload_telemetry(
        &self,
        org_id: &str,
        job_id: &str,
        retention_days: Option<i32>,
        path: &std::path::Path,
    ) -> Result<Option<ArtifactRef>, String> {
        if tokio::fs::metadata(path).await.is_err() {
            return Ok(None);
        }
        let key = Storage::key_for(org_id, job_id, retention_days, "telemetry", "json");
        let stored = self
            .storage
            .put_file(&key, path, "application/json")
            .await?;
        Ok(Some(ArtifactRef {
            kind: "telemetry",
            storage_key: stored.storage_key,
            content_type: "application/json".into(),
            bytes: stored.bytes,
            sha256: stored.sha256_hex,
            duration_seconds: None,
            width: None,
            height: None,
        }))
    }

    /// The heartbeat, for the life of one take.
    ///
    /// It extends the lease, publishes progress and learns about a cancel, all in the one
    /// call `report_progress` was designed as. It is a task rather than part of the loop
    /// because the loop is blocked on a child process for minutes at a time, and the whole
    /// point of a heartbeat is that it keeps going while nothing else does.
    fn spawn_heartbeat(
        &self,
        job_id: String,
        token: String,
        progress: watch::Receiver<Progress>,
        cancel: watch::Sender<bool>,
        lease_lost: Arc<AtomicBool>,
        ops: Vec<Value>,
    ) -> tokio::task::JoinHandle<()> {
        let control = Arc::clone(&self.control);
        let every = self.cfg.heartbeat;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(every);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                // Cloned out of the watch guard explicitly, so the borrow is released
                // before the await below rather than being held across it.
                let p = Progress::clone(&progress.borrow());
                let (fraction, message) = describe(&p, &ops);
                match control
                    .report_progress(&job_id, &token, fraction, &message, None)
                    .await
                {
                    Ok(hb) => {
                        tracing::debug!(job = %job_id, state = %hb.state, progress = fraction, "heartbeat");
                        if hb.cancel_requested {
                            let _ = cancel.send(true);
                        }
                    }
                    Err(ControlError::LeaseLost(m)) => {
                        // Losing the lease means another box either has this job or is
                        // about to. Carrying on would be filming a take whose result we
                        // are not allowed to report, so the take is stopped the same way a
                        // cancel stops it.
                        tracing::warn!(job = %job_id, reason = %m, "heartbeat refused; stopping the take");
                        lease_lost.store(true, Ordering::Relaxed);
                        let _ = cancel.send(true);
                        return;
                    }
                    // A transport failure is one lost beat, not a lost job. The lease is
                    // three beats long precisely so that this is survivable.
                    Err(e) => tracing::warn!(job = %job_id, error = %e, "heartbeat failed"),
                }
            }
        })
    }
}

/// Progress as a fraction, and the line the dashboard shows.
///
/// The op description comes from the redactor, so a `type` op reports its selector and the
/// length of what was typed and never the text itself. That matters here as well as in the
/// log, because this string is stored on the job row.
fn describe(p: &Progress, ops: &[Value]) -> (f32, String) {
    let total = ops.len().max(1);
    match p.phase {
        Phase::Starting => (0.02, "starting the browser".to_string()),
        Phase::Filming => {
            let done = p.ops_done.min(total);
            let next = ops.get(done).map(redact::op_for_log).unwrap_or_default();
            (
                // Capture is most of a take, and the render pass that follows it is
                // roughly the last tenth. The five percent floor keeps a long first
                // navigate from looking like nothing is happening.
                0.05 + 0.85 * (done as f32 / total as f32),
                format!("op {} of {}: {}", done + 1, total, next),
            )
        }
        Phase::Rendering => (0.92, "rendering the video".to_string()),
    }
}

/// What to call the outcome. `None` for the code means the take succeeded.
///
/// Truncation with a usable video is a success, which is the whole point of truncating
/// rather than failing: a customer whose script outran the limit gets the first half of
/// their demo instead of an error.
fn classify(
    outcome: &crate::backend::RenderOutcome,
    have_video: bool,
    budget_seconds: u64,
) -> (Option<&'static str>, String, bool) {
    if outcome.spool_limit {
        return (
            Some("spool_limit"),
            "the take filled its frame spool; shorten it or lower the scale".into(),
            // The same script will fill the same spool on the next box.
            false,
        );
    }
    if outcome.truncated && !have_video {
        return (
            Some("job_timeout"),
            format!("the take passed its {budget_seconds}s limit and produced no usable video"),
            false,
        );
    }
    if outcome.truncated {
        return (None, String::new(), false);
    }
    if outcome.killed {
        return (
            Some("job_timeout"),
            "the render container had to be killed".into(),
            true,
        );
    }
    if outcome.exit_code == Some(0) && have_video {
        return (None, String::new(), false);
    }
    if let Some(f) = &outcome.failure {
        return (
            Some(script::classify_op_failure(&f.error)),
            format!("op {} ({}): {}", f.index, f.op, f.error),
            // A script that fails on op 7 fails on op 7 again. Retrying costs the customer
            // three times the render seconds for the same answer.
            false,
        );
    }
    // No op failed and there is still no video. The recorder never got far enough to
    // report anything, which on a render box is usually the browser.
    let stderr = outcome.stderr_tail.to_ascii_lowercase();
    if stderr.contains("chromium") || stderr.contains("browser") || stderr.contains("launch") {
        return (
            Some("browser_launch_failed"),
            "the browser did not start on this box".into(),
            true,
        );
    }
    (
        Some("render_failed"),
        format!(
            "the recorder exited with {} and produced no usable video",
            outcome
                .exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "a signal".into())
        ),
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::{OpFailure, RenderOutcome};

    fn outcome() -> RenderOutcome {
        RenderOutcome {
            exit_code: Some(0),
            ..Default::default()
        }
    }

    #[test]
    fn an_abandoned_container_is_never_read_as_a_finished_take() {
        // What actually handles abandonment is the early return in run_inner, which reports
        // nothing at all so the lease lapses. This test guards the fallback: if somebody
        // deletes that return, the take must still not come out of the classifier as done,
        // because the container that would be writing that video is the one this box could
        // not stop.
        let o = RenderOutcome {
            abandoned: true,
            killed: true,
            exit_code: None,
            ..Default::default()
        };
        assert_eq!(classify(&o, false, 1800).0, Some("job_timeout"));
        assert!(
            classify(&o, true, 1800).0.is_some(),
            "a video on disk does not make an abandoned container a success"
        );
    }

    #[test]
    fn a_truncated_take_with_footage_is_a_success_not_a_failure() {
        let o = RenderOutcome {
            truncated: true,
            exit_code: Some(1),
            ..Default::default()
        };
        let (code, _, _) = classify(&o, true, 1800);
        assert!(
            code.is_none(),
            "the supervisor renders what it has rather than failing"
        );
    }

    #[test]
    fn a_truncated_take_with_nothing_to_show_is_a_timeout_and_is_not_retried() {
        let o = RenderOutcome {
            truncated: true,
            exit_code: Some(1),
            ..Default::default()
        };
        let (code, _, retryable) = classify(&o, false, 1800);
        assert_eq!(code, Some("job_timeout"));
        assert!(!retryable);
    }

    #[test]
    fn a_failing_op_is_the_customers_and_is_never_retried() {
        let o = RenderOutcome {
            exit_code: Some(1),
            failure: Some(OpFailure {
                index: 7,
                op: "click".into(),
                error: "selector matched a non-visible element: #done".into(),
            }),
            ..Default::default()
        };
        let (code, message, retryable) = classify(&o, true, 1800);
        assert_eq!(code, Some("op_failed"));
        assert!(!retryable);
        assert!(message.contains("op 7"));
    }

    #[test]
    fn a_box_that_could_not_start_a_browser_hands_the_job_back() {
        let o = RenderOutcome {
            exit_code: Some(1),
            stderr_tail: "kaviri: error: chromium exited before the debugger port appeared".into(),
            ..Default::default()
        };
        let (code, _, retryable) = classify(&o, false, 1800);
        assert_eq!(code, Some("browser_launch_failed"));
        assert!(retryable, "another box may well be fine");
    }

    #[test]
    fn a_clean_run_with_a_video_reports_nothing_at_all() {
        let (code, _, _) = classify(&outcome(), true, 1800);
        assert!(code.is_none());
    }

    #[test]
    fn a_clean_exit_with_no_video_is_still_a_failure() {
        let (code, _, retryable) = classify(&outcome(), false, 1800);
        assert_eq!(code, Some("render_failed"));
        assert!(retryable);
    }

    #[test]
    fn the_progress_message_never_carries_what_was_typed() {
        let ops = vec![
            json!({"op": "navigate", "url": "https://x.test/?token=abc"}),
            json!({"op": "type", "selector": "#pw", "text": "hunter2"}),
        ];
        let p = Progress {
            ops_done: 1,
            phase: Phase::Filming,
        };
        let (fraction, message) = describe(&p, &ops);
        assert!(message.contains("op 2 of 2"));
        assert!(!message.contains("hunter2"));
        assert!(fraction > 0.05 && fraction < 0.95);
    }
}
