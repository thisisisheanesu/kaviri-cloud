//! Where a take actually runs.
//!
//! One Hetzner box at launch, behind this trait. Not Modal: the owner's Modal account was
//! disabled by a spend cap in August, which is the render fleet going dark on a billing
//! event, and a demo video that is a build artifact cannot have a build step that does
//! that. A box that is paid for by the month fails in ways you can see coming.
//!
//! The trait exists so that the day elasticity is worth more than predictability, Fly
//! Machines is a new module and a new variant of `BackendChoice`, not an edit to the job
//! loop. Everything the loop needs is in `RenderRequest` and `RenderOutcome`, and nothing
//! in either mentions a container, a machine or a host, so a backend that creates a
//! machine, streams its logs and destroys it satisfies the same contract as one that runs
//! `docker run`. The one thing a backend must preserve is the truncation behaviour: at the
//! soft deadline the recorder is asked to stop politely, and what it has captured is
//! rendered. A backend that kills the process instead turns a slow take into no take.

pub mod docker;

use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::watch;

/// Names inside the job directory. They are constants because the backend mounts the
/// directory and the job loop reads what is in it afterwards, and the two must agree.
pub const SCRIPT_FILE: &str = "script.jsonl";
pub const OUT_FILE: &str = "take.mp4";
pub const TELEMETRY_FILE: &str = "telemetry.json";

/// What to film, and the envelope it has to stay inside.
pub struct RenderRequest {
    pub job_id: String,
    pub attempt: i32,
    /// Host directory holding `script.jsonl` and receiving `take.mp4`.
    pub host_dir: PathBuf,
    /// Host directory for the frame spool and the CFR intermediate. Separate from the job
    /// directory because it is the one that grows by tens of megabytes a second and the
    /// one an operator will want on a different disk.
    pub host_spool: PathBuf,
    /// Recorder flags derived from the job's options. Never includes a path.
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub total_ops: usize,
    /// When the take is truncated. The recorder is asked to stop, and it renders what it
    /// captured.
    pub soft_deadline: Duration,
    /// How long the render pass gets after that before the process is killed outright.
    pub render_grace: Duration,
    pub max_spool_bytes: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Phase {
    #[default]
    Starting,
    Filming,
    Rendering,
}

#[derive(Clone, Default)]
pub struct Progress {
    pub ops_done: usize,
    pub phase: Phase,
}

/// The op that ended the script, as the recorder reported it.
#[derive(Clone, Debug)]
pub struct OpFailure {
    /// One based, matching the recorder's own numbering and the `op_index` the API returns.
    pub index: usize,
    pub op: String,
    pub error: String,
}

#[derive(Debug, Default)]
pub struct RenderOutcome {
    pub exit_code: Option<i32>,
    /// The soft deadline was reached and the take was cut short. The video is real, it is
    /// simply shorter than the script asked for.
    pub truncated: bool,
    /// The process had to be killed, which means there is probably no usable video.
    pub killed: bool,
    pub cancelled: bool,
    /// The spool watchdog stopped the take.
    pub spool_limit: bool,
    pub ops_completed: usize,
    pub failure: Option<OpFailure>,
    /// The last few lines the recorder wrote to stderr, already redacted.
    pub stderr_tail: String,
    pub wall_seconds: f64,
}

/// What ffprobe says about a file the take produced.
#[derive(Debug, Default, Clone)]
pub struct MediaInfo {
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[async_trait::async_trait]
pub trait RenderBackend: Send + Sync {
    fn name(&self) -> &'static str;

    /// Checked once at startup, so a box with the wrong image or a missing network fails
    /// before it leases a customer's job rather than after.
    async fn preflight(&self) -> Result<(), String>;

    async fn run(
        &self,
        req: RenderRequest,
        progress: watch::Sender<Progress>,
        cancel: watch::Receiver<bool>,
    ) -> Result<RenderOutcome, String>;

    /// Duration and dimensions of a produced file.
    ///
    /// On the trait rather than in a helper because it has to run against the same pinned
    /// ffmpeg that produced the file. A host ffmpeg of a different vintage reporting a
    /// different duration would put a number in the artifact row that does not describe
    /// the object, and the host would then need ffmpeg installed at all, which is a
    /// dependency the whole point of the image was to remove.
    async fn probe(&self, file: &Path) -> Result<MediaInfo, String>;
}

/// The Chromium flags the fleet adds to every take, on top of whatever the recorder sets.
///
/// This is one half of the egress story and the weaker half. Read `docker/README.md` for
/// the other half, which is netfilter, and for why this alone is not enough: Chromium's
/// host resolver is not consulted for a URL that already contains an IP literal, so
/// `http://169.254.169.254/` does not pass through these rules at all. What the rules do
/// close is every name based route to the same places, which is what a script that was
/// copied off the internet will actually contain.
///
/// `~NOTFOUND` makes the name fail to resolve, which the page sees as an ordinary DNS
/// failure. That is deliberate: a hang would eat the take's wall clock budget, and a
/// redirect to somewhere harmless would make a script that is probing us look like it
/// succeeded.
pub fn chromium_args() -> String {
    [
        "--host-resolver-rules=",
        "MAP metadata.google.internal ~NOTFOUND,",
        "MAP metadata ~NOTFOUND,",
        "MAP metadata.goog ~NOTFOUND,",
        "MAP instance-data ~NOTFOUND,",
        "MAP instance-data.ec2.internal ~NOTFOUND,",
        "MAP 169.254.169.254 ~NOTFOUND,",
        "MAP *.internal ~NOTFOUND,",
        "MAP *.cluster.local ~NOTFOUND,",
        "MAP *.local ~NOTFOUND,",
        "MAP localhost ~NOTFOUND,",
        "MAP *.localhost ~NOTFOUND",
    ]
    .concat()
}

/// Bytes currently in a directory tree.
///
/// Used by the spool watchdog. The recorder caps its own frame spool, but the CFR
/// intermediate and the backdrop plate are written under `TMPDIR`, which is the same
/// filesystem and is not counted against that cap, so a take that is inside the recorder's
/// limit can still be outside ours.
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    for entry in entries.flatten() {
        match entry.metadata() {
            Ok(m) if m.is_dir() => total += dir_size(&entry.path()),
            Ok(m) => total += m.len(),
            Err(_) => {}
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_resolver_rules_name_every_metadata_spelling_we_know_of() {
        let args = chromium_args();
        for name in [
            "metadata.google.internal",
            "instance-data",
            "169.254.169.254",
            "localhost",
        ] {
            assert!(args.contains(name), "{name} must be mapped to NOTFOUND");
        }
        // One flag, comma separated. A second --host-resolver-rules would silently replace
        // the first rather than adding to it.
        assert_eq!(args.matches("--host-resolver-rules").count(), 1);
        assert!(!args.contains(",,"));
        assert!(!args.ends_with(','));
    }
}
