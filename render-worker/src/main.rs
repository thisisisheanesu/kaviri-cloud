//! kaviri-cloud render worker.
//!
//! A long lived process on one Hetzner box. It leases a job from the queue, films it in a
//! container that is destroyed afterwards, uploads the MP4 to R2 and reports the outcome.
//! It holds a JWT for a Postgres role that can call three functions and read no table, and
//! an R2 credential. It holds no service role key, because it is the machine that runs
//! customer supplied scripts and that is exactly the machine that should not be able to
//! read another tenant's row.
//!
//!   kaviri-render-worker            lease jobs until told to stop
//!   kaviri-render-worker doctor     check the configuration and the box, then exit

mod backend;
mod config;
mod control;
mod job;
mod options;
mod redact;
mod script;
mod storage;

use backend::RenderBackend;
use config::{BackendChoice, Config};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[tokio::main]
async fn main() {
    // JSON on a box, because the line is going to a log shipper rather than to a person,
    // and a person reading it locally can set KAVIRI_LOG_FORMAT=text.
    let filter = tracing_subscriber::EnvFilter::try_from_env("KAVIRI_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    if std::env::var("KAVIRI_LOG_FORMAT").as_deref() == Ok("text") {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    } else {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(filter)
            .init();
    }

    let doctor = std::env::args().nth(1).as_deref() == Some("doctor");

    if let Err(e) = run(doctor).await {
        tracing::error!("{e}");
        std::process::exit(1);
    }
}

async fn run(doctor: bool) -> Result<(), String> {
    let cfg = Arc::new(Config::from_env()?);
    std::fs::create_dir_all(&cfg.work_root)
        .map_err(|e| format!("cannot create {}: {e}", cfg.work_root.display()))?;

    let backend: Arc<dyn RenderBackend> = match cfg.backend {
        BackendChoice::Docker => Arc::new(backend::docker::DockerBackend::new(&cfg)?),
    };
    backend.preflight().await?;

    let free = free_bytes(&cfg.work_root)?;
    if free < cfg.min_free_bytes {
        return Err(format!(
            "{} has {} MiB free and the worker wants at least {} MiB; a take spools at roughly \
             15 to 25 MB per second and filling this disk takes the next three jobs down with it",
            cfg.work_root.display(),
            free / (1024 * 1024),
            cfg.min_free_bytes / (1024 * 1024)
        ));
    }

    let control = Arc::new(control::Control::new(&cfg)?);
    let storage = Arc::new(storage::Storage::new(&cfg)?);

    tracing::info!(
        worker = %cfg.worker_id,
        backend = backend.name(),
        image = %cfg.render_image,
        slots = cfg.max_concurrent_jobs,
        free_gib = free / (1024 * 1024 * 1024),
        "render worker ready"
    );

    if doctor {
        println!("configuration and box look usable; no job was leased");
        return Ok(());
    }

    // Anything left from a previous life of this process. A worker that was killed mid
    // take left a directory holding a customer's script and possibly their video, and the
    // job itself has long since been reaped and re-run somewhere else.
    sweep_work_root(&cfg).await;

    let unhealthy = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let runner = Arc::new(job::Runner {
        cfg: Arc::clone(&cfg),
        control: Arc::clone(&control),
        storage: Arc::clone(&storage),
        backend: Arc::clone(&backend),
        unhealthy: Arc::clone(&unhealthy),
    });

    let slots = Arc::new(Semaphore::new(cfg.max_concurrent_jobs));
    let mut shutdown = shutdown_signal();
    let mut gave_up = false;

    loop {
        // A box that has abandoned a container stops taking work. It has already shown it
        // cannot end a container, so the next take would be leased onto the same wedged
        // daemon with a runaway container still holding the disk, and it would very likely
        // be abandoned too. Draining and exiting hands every job in flight back cleanly and
        // lets systemd restart the process, and the restart re runs preflight, which is
        // where a daemon in this state is diagnosed rather than merely suffered.
        if unhealthy.load(std::sync::atomic::Ordering::Relaxed) {
            tracing::error!(
                "a render container could not be stopped on this box; leasing no further jobs"
            );
            gave_up = true;
            break;
        }

        // Acquired before the lease, not after. Leasing a job this box has no slot for
        // would hold a customer's take hostage for the length of another take, and the
        // queue cannot tell the difference between that and a dead worker.
        let permit = tokio::select! {
            p = Arc::clone(&slots).acquire_owned() => match p {
                Ok(p) => p,
                Err(_) => break,
            },
            _ = &mut shutdown => break,
        };

        let lease = tokio::select! {
            r = control.lease_next_job() => r,
            _ = &mut shutdown => break,
        };

        match lease {
            Ok(Some(lease)) => {
                let runner = Arc::clone(&runner);
                tokio::spawn(async move {
                    runner.run(lease).await;
                    // Held until the job is fully reported, so the slot count is a count of
                    // takes in flight rather than of containers running.
                    drop(permit);
                });
            }
            Ok(None) => {
                drop(permit);
                tokio::select! {
                    _ = tokio::time::sleep(cfg.poll_idle) => {}
                    _ = &mut shutdown => break,
                }
            }
            Err(e) => {
                drop(permit);
                // The queue being unreachable is not this worker's problem to solve, and
                // hammering it makes it somebody's. The idle interval is the backoff.
                tracing::warn!(error = %e, "could not lease a job");
                tokio::select! {
                    _ = tokio::time::sleep(cfg.poll_idle * 2) => {}
                    _ = &mut shutdown => break,
                }
            }
        }
    }

    // A take in flight is a customer waiting on a video, and it has at most the job budget
    // left to run. Draining beats killing it: killing it costs the customer a retry and
    // costs us the render seconds twice.
    tracing::info!("shutting down; waiting for jobs in flight to finish");
    let _ = slots.acquire_many(cfg.max_concurrent_jobs as u32).await;
    if gave_up {
        // A non zero exit, so systemd restarts the worker rather than recording a clean
        // stop, and so an operator reading `systemctl status` sees a failure rather than a
        // process that decided to end.
        return Err(
            "stopped after abandoning a render container; the container may still be running \
             and this box needs a human before it films anything else"
                .into(),
        );
    }
    tracing::info!("stopped");
    Ok(())
}

/// SIGTERM from systemd, or a Ctrl-C from somebody on the box.
fn shutdown_signal() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::error!("cannot listen for SIGTERM: {e}");
                    return;
                }
            };
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    })
}

/// Free bytes on the filesystem holding a path.
///
/// Shelling out to `df` rather than taking a libc dependency for one `statvfs`. The worker
/// already spawns processes for every take, so this is not a new capability, and one fewer
/// crate on the box that runs customer scripts is worth a fork per startup.
pub(crate) fn free_bytes(path: &std::path::Path) -> Result<u64, String> {
    let out = std::process::Command::new("df")
        .arg("-PB1")
        .arg(path)
        .output()
        .map_err(|e| format!("cannot run df: {e}"))?;
    if !out.status.success() {
        return Err(format!("df failed for {}", path.display()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .nth(1)
        .and_then(|l| l.split_whitespace().nth(3))
        .and_then(|n| n.parse::<u64>().ok())
        .ok_or_else(|| format!("cannot read df output for {}", path.display()))
}

/// Remove whatever a previous run left behind.
///
/// Every one of these directories holds a customer's script, and possibly their video, for
/// a job that is no longer ours. There is nothing to recover: the lease lapsed, the reaper
/// requeued the job, and another attempt has already run or is about to.
async fn sweep_work_root(cfg: &Config) {
    let Ok(mut entries) = tokio::fs::read_dir(&cfg.work_root).await else {
        return;
    };
    let mut removed = 0usize;
    while let Ok(Some(entry)) = entries.next_entry().await {
        if entry.path().is_dir() && tokio::fs::remove_dir_all(entry.path()).await.is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        tracing::warn!(
            count = removed,
            "removed job directories left by a previous run"
        );
    }
}
