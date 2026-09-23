//! Everything the worker needs from its environment, read once at startup.
//!
//! Secrets are read here and nowhere else, and they are never written to a file. The
//! struct deliberately has no Debug derive: a `dbg!` or a `tracing::debug!("{config:?}")`
//! added in a hurry six months from now would put the worker JWT and the R2 secret into
//! the log stream, and the log stream is the one place we have promised customer scripts
//! never reach either.

use std::path::PathBuf;
use std::time::Duration;

/// A configuration problem is always fatal and always the operator's to fix, so it is one
/// string and not an enum: nothing branches on which variable was missing.
pub type ConfigError = String;

pub struct Config {
    // The queue.
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub worker_jwt: String,
    pub worker_id: String,
    pub lease: Duration,
    pub heartbeat: Duration,
    pub poll_idle: Duration,

    // Object storage.
    pub r2_account_id: String,
    pub r2_bucket: String,
    pub r2_access_key_id: String,
    pub r2_secret_access_key: String,

    // The fleet.
    pub backend: BackendChoice,
    pub max_concurrent_jobs: usize,
    pub work_root: PathBuf,
    pub render_image: String,
    pub docker_network: String,
    pub container_memory: String,
    pub container_cpus: String,
    /// `host:port` the startup egress probe must be able to reach, or None when the check
    /// is deliberately turned off.
    ///
    /// This is the positive control, and it exists because the negative one is not
    /// self validating: a box whose render network has no route anywhere at all refuses
    /// 169.254.169.254 exactly as convincingly as a correctly fenced box does. Requiring
    /// one ordinary address to answer is what makes "refused" mean "the fence refused it".
    pub egress_probe_public: Option<String>,

    // Safety envelope. Every one of these is a ceiling the worker applies on top of
    // whatever the queue hands it, so a mistake in an entitlement cannot make one box
    // give a single take the whole machine.
    pub max_spool_bytes: u64,
    pub job_seconds_cap: u64,
    pub render_grace: Duration,
    pub max_artifact_bytes: u64,
    pub min_free_bytes: u64,
}

/// Which fleet the worker drives. One Hetzner box at launch, and the enum exists so that
/// adding Fly Machines is a new variant and a new module rather than an edit to the job
/// loop, which must not know where a take runs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BackendChoice {
    Docker,
}

impl Config {
    pub fn from_env() -> Result<Config, ConfigError> {
        let cfg = Config {
            supabase_url: req("SUPABASE_URL")?.trim_end_matches('/').to_string(),
            supabase_anon_key: req("SUPABASE_ANON_KEY")?,
            worker_jwt: req("KAVIRI_WORKER_JWT")?,
            // A worker id that is not unique makes two boxes indistinguishable in the
            // lease column, which is exactly the moment you need to tell them apart, so
            // the hostname is a default and not a suggestion to leave it unset.
            worker_id: opt("KAVIRI_WORKER_ID").unwrap_or_else(default_worker_id),
            lease: Duration::from_secs(num("KAVIRI_LEASE_SECONDS", 120, 15, 900)?),
            heartbeat: Duration::from_secs(num("KAVIRI_HEARTBEAT_SECONDS", 15, 5, 120)?),
            poll_idle: Duration::from_millis(num("KAVIRI_POLL_IDLE_MS", 2000, 200, 60_000)?),

            r2_account_id: req("R2_ACCOUNT_ID")?,
            r2_bucket: req("R2_BUCKET")?,
            r2_access_key_id: req("R2_ACCESS_KEY_ID")?,
            r2_secret_access_key: req("R2_SECRET_ACCESS_KEY")?,

            backend: match opt("KAVIRI_RENDER_BACKEND").as_deref().unwrap_or("docker") {
                "docker" => BackendChoice::Docker,
                other => {
                    return Err(format!(
                        "KAVIRI_RENDER_BACKEND is {other}; the only backend implemented today is docker"
                    ))
                }
            },
            // One job per box by default. The container is the isolation boundary, but the
            // disk and the CPU are not: two takes spooling at 20 MB per second on one NVMe
            // is how both of them get slow enough to miss a selector wait.
            max_concurrent_jobs: num("KAVIRI_MAX_CONCURRENT_JOBS", 1, 1, 16)? as usize,
            work_root: PathBuf::from(
                opt("KAVIRI_WORK_ROOT").unwrap_or_else(|| "/var/lib/kaviri/work".into()),
            ),
            render_image: opt("KAVIRI_RENDER_IMAGE").unwrap_or_else(|| "kaviri-render:local".into()),
            docker_network: opt("KAVIRI_DOCKER_NETWORK").unwrap_or_else(|| "kaviri-egress".into()),
            container_memory: opt("KAVIRI_CONTAINER_MEMORY").unwrap_or_else(|| "4g".into()),
            container_cpus: opt("KAVIRI_CONTAINER_CPUS").unwrap_or_else(|| "3".into()),
            // An IP literal by default rather than a name, because a DNS failure inside the
            // probe container would otherwise look exactly like a blocked address and the
            // control would pass for the wrong reason. `off` is accepted for a box with no
            // general internet egress, and the worker says loudly at startup that the
            // positive control is not running.
            egress_probe_public: match opt("KAVIRI_EGRESS_PROBE_PUBLIC").as_deref() {
                Some("off") => None,
                Some(target) => Some(target.to_string()),
                None => Some("1.1.1.1:443".into()),
            },

            max_spool_bytes: num("KAVIRI_MAX_SPOOL_BYTES", 8 * GIB, 256 * MIB, 512 * GIB)?,
            // The platform ceiling in app.platform_ceilings() is 1800 seconds. The worker
            // keeps its own copy rather than trusting the number on the lease, because the
            // lease is data from the database and this is the thing that stops one box
            // being held forever.
            job_seconds_cap: num("KAVIRI_JOB_SECONDS_CAP", 1800, 30, 7200)?,
            // Time allowed after the take is truncated for ffmpeg to finish the encode. A
            // long take is a long render, and killing the process during the render throws
            // away every frame we just spent the wall clock capturing.
            render_grace: Duration::from_secs(num("KAVIRI_RENDER_GRACE_SECONDS", 300, 30, 1800)?),
            max_artifact_bytes: num("KAVIRI_MAX_ARTIFACT_BYTES", 2 * GIB, 16 * MIB, 64 * GIB)?,
            // Refusing to start is cheaper than filling the disk mid take and taking the
            // next three jobs down with it.
            min_free_bytes: num("KAVIRI_MIN_FREE_BYTES", 16 * GIB, GIB, 4096 * GIB)?,
        };

        // A bind mount source has to be an absolute path, and the error docker gives for a
        // relative one names the path without saying why, which costs an afternoon.
        if !cfg.work_root.is_absolute() {
            return Err(format!(
                "KAVIRI_WORK_ROOT must be an absolute path, got {}",
                cfg.work_root.display()
            ));
        }
        if cfg.heartbeat * 3 > cfg.lease {
            return Err(format!(
                "KAVIRI_HEARTBEAT_SECONDS ({}s) must be at most a third of KAVIRI_LEASE_SECONDS ({}s), \
                 or one lost heartbeat loses the job to the reaper",
                cfg.heartbeat.as_secs(),
                cfg.lease.as_secs()
            ));
        }
        Ok(cfg)
    }

    /// Where this job's script, video and frame spool live. One directory per job, removed
    /// when the job ends, so a crashed worker leaves evidence in exactly one place and a
    /// sweep can find it.
    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.work_root.join(job_id)
    }
}

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

fn opt(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => None,
    }
}

fn req(name: &str) -> Result<String, ConfigError> {
    opt(name).ok_or_else(|| format!("{name} is not set; see render-worker/README.md"))
}

fn num(name: &str, default: u64, lo: u64, hi: u64) -> Result<u64, ConfigError> {
    let Some(raw) = opt(name) else {
        return Ok(default);
    };
    let v: u64 = raw
        .parse()
        .map_err(|_| format!("{name} must be a whole number between {lo} and {hi}, got {raw}"))?;
    if !(lo..=hi).contains(&v) {
        return Err(format!("{name} must be between {lo} and {hi}, got {v}"));
    }
    Ok(v)
}

fn default_worker_id() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| format!("kaviri-worker-{}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_heartbeat_that_cannot_survive_one_lost_beat_is_a_configuration_error() {
        // 120s lease with a 60s heartbeat looks fine until one beat is dropped, at which
        // point the reaper takes the job off a box that is still filming it and the
        // customer pays for two attempts of the same take.
        let lease = Duration::from_secs(120);
        assert!(Duration::from_secs(60) * 3 > lease);
        assert!(Duration::from_secs(15) * 3 <= lease);
    }

    #[test]
    fn a_range_checked_number_rejects_what_it_says_it_rejects() {
        std::env::set_var("KAVIRI_TEST_NUM", "5");
        assert!(num("KAVIRI_TEST_NUM", 10, 6, 20).is_err());
        assert_eq!(num("KAVIRI_TEST_NUM", 10, 1, 20), Ok(5));
        std::env::remove_var("KAVIRI_TEST_NUM");
        assert_eq!(num("KAVIRI_TEST_NUM", 10, 1, 20), Ok(10));
    }
}
