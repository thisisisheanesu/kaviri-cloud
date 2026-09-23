//! The worker's entire database surface: three functions, called over PostgREST.
//!
//! The fleet holds a JWT whose role claim is `kaviri_worker`. That role can execute
//! `lease_next_job`, `report_progress` and `complete_job` and can select, insert and
//! update nothing, so this module has no table access to lose. There is no service role
//! key on a machine that runs customer scripts, and adding one here would quietly undo the
//! reason the three functions exist.
//!
//! Within the three, authority is per job. `lease_next_job` returns a `lease_token` once;
//! every later call carries it, and a worker whose lease was reaped finds out by being
//! refused rather than by overwriting the result of the worker that replaced it.

use crate::config::Config;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

pub struct Control {
    http: reqwest::Client,
    base: String,
    anon_key: String,
    jwt: String,
    worker_id: String,
    lease_seconds: u64,
}

/// What went wrong talking to the queue.
///
/// `LeaseLost` is separated from the rest because it is the one failure the job loop must
/// not retry and must not report: the job already belongs to somebody else, and anything
/// this worker says about it from here on is a lie about a take it no longer owns.
///
/// `Abandoned` is not a queue error at all, and it lives here anyway because this enum is
/// the channel by which a job ends without an outcome being reported. It means the reverse
/// of `LeaseLost`: this worker still holds the lease and has decided it must not use it,
/// because a container it could not kill may still be filming the take. The two share the
/// one property that matters at the call site, which is that saying nothing and letting the
/// lease lapse is the correct ending.
#[derive(Debug)]
pub enum ControlError {
    LeaseLost(String),
    Abandoned(String),
    Rejected { code: String, message: String },
    Transport(String),
}

impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ControlError::LeaseLost(m) => write!(f, "lease lost: {m}"),
            ControlError::Abandoned(m) => write!(f, "job abandoned: {m}"),
            ControlError::Rejected { code, message } => {
                write!(f, "queue rejected the call ({code}): {message}")
            }
            ControlError::Transport(m) => write!(f, "queue unreachable: {m}"),
        }
    }
}

impl std::error::Error for ControlError {}

pub type Result<T> = std::result::Result<T, ControlError>;

/// One leased job, exactly as `lease_next_job` returns it.
#[derive(Debug, Deserialize)]
pub struct Lease {
    pub job_id: String,
    pub org_id: String,
    pub project_id: String,
    pub lease_token: String,
    pub attempt: i32,
    pub max_attempts: i32,
    pub script: Value,
    pub options: Value,
    /// The org's per job wall clock ceiling, already carrying the platform ceiling. The
    /// worker clamps its own cap on top rather than trusting it outright.
    pub max_job_seconds: i64,
    /// How long this org's artifacts are kept, or None for unlimited. Needed before the
    /// upload rather than after it, because the retention class is a segment of the object
    /// key: see `Storage::key_for`.
    #[serde(default)]
    pub artifact_retention_days: Option<i32>,
}

impl Lease {
    /// The script as a list of ops, or an explanation of why it is not one.
    ///
    /// `render_jobs.script` is constrained to a JSON array in the schema, so this should
    /// never fail. It is checked anyway because the alternative to checking is indexing
    /// into whatever arrived and taking the whole worker down with a panic on one bad row.
    pub fn ops(&self) -> std::result::Result<&Vec<Value>, String> {
        self.script
            .as_array()
            .ok_or_else(|| "script is not a JSON array".to_string())
    }
}

/// What `report_progress` says back. The heartbeat is also how a worker learns it has been
/// cancelled, which is why cancellation costs no extra round trip.
#[derive(Debug, Deserialize)]
pub struct Heartbeat {
    pub state: String,
    pub cancel_requested: bool,
}

/// The outcome the worker reports. The strings are what `complete_job` accepts, and it
/// raises on anything else, so they are an enum here rather than call sites passing text.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    Done,
    Failed,
    Cancelled,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::Done => "done",
            Outcome::Failed => "failed",
            Outcome::Cancelled => "cancelled",
        }
    }
}

/// An artifact the worker has ALREADY uploaded. Upload first, then report: a row pointing
/// at an object that does not exist is a 404 on the customer's link, whereas an object
/// with no row is a sweep's problem.
#[derive(Debug, serde::Serialize)]
pub struct ArtifactRef {
    pub kind: &'static str,
    pub storage_key: String,
    pub content_type: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct Completion {
    pub state: String,
    pub retry_at: Option<String>,
}

#[derive(Deserialize)]
struct PostgrestError {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
}

impl Control {
    pub fn new(cfg: &Config) -> std::result::Result<Control, String> {
        let http = reqwest::Client::builder()
            // Every call here is a small JSON round trip against one host. A connect that
            // has not completed in five seconds is a network problem, and hanging on it
            // means the heartbeat that would have kept the lease alive never goes out.
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .user_agent(concat!("kaviri-render-worker/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("cannot build an HTTP client: {e}"))?;
        Ok(Control {
            http,
            base: format!("{}/rest/v1/rpc", cfg.supabase_url),
            anon_key: cfg.supabase_anon_key.clone(),
            jwt: cfg.worker_jwt.clone(),
            worker_id: cfg.worker_id.clone(),
            lease_seconds: cfg.lease.as_secs(),
        })
    }

    async fn rpc(&self, function: &str, body: Value) -> Result<Value> {
        let res = self
            .http
            .post(format!("{}/{function}", self.base))
            .header("apikey", &self.anon_key)
            .bearer_auth(&self.jwt)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;

        let status = res.status();
        let text = res
            .text()
            .await
            .map_err(|e| ControlError::Transport(e.to_string()))?;

        if status.is_success() {
            return serde_json::from_str(&text).map_err(|e| {
                ControlError::Transport(format!("{function} returned unparseable JSON: {e}"))
            });
        }

        let err: PostgrestError = serde_json::from_str(&text).unwrap_or(PostgrestError {
            code: status.as_u16().to_string(),
            message: text.chars().take(300).collect(),
        });
        // 42501 is what report_progress and complete_job raise when the token does not
        // match a live lease, which means this worker no longer owns the job.
        if err.code == "42501" {
            return Err(ControlError::LeaseLost(err.message));
        }
        Err(ControlError::Rejected {
            code: err.code,
            message: err.message,
        })
    }

    /// Take the next job, or nothing.
    ///
    /// An empty result is the normal case on an idle fleet and is not an error: the queue
    /// is empty, the org at the front is at its concurrency limit, or every visible job is
    /// held back by a retry backoff.
    pub async fn lease_next_job(&self) -> Result<Option<Lease>> {
        let rows = self
            .rpc(
                "lease_next_job",
                json!({
                    "p_worker_id": self.worker_id,
                    "p_lease_seconds": self.lease_seconds,
                    // Declared so that a future scheduler can route a take to a box that
                    // has the codec or the font set it needs. Nothing reads it today.
                    "p_capabilities": {
                        "worker_version": env!("CARGO_PKG_VERSION"),
                        "backend": "docker",
                    },
                }),
            )
            .await?;
        let Some(first) = rows.as_array().and_then(|a| a.first()) else {
            return Ok(None);
        };
        serde_json::from_value(first.clone())
            .map(Some)
            .map_err(|e| {
                ControlError::Transport(format!(
                    "lease_next_job row does not match the contract: {e}"
                ))
            })
    }

    /// The heartbeat. It extends the lease, moves the job through the in flight states and
    /// reports whether the customer has asked for a cancel, in one round trip, because the
    /// worker is in the middle of a capture pump and every millisecond spent here is a
    /// millisecond of the filmed app running slower.
    pub async fn report_progress(
        &self,
        job_id: &str,
        lease_token: &str,
        progress: f32,
        message: &str,
        state: Option<&str>,
    ) -> Result<Heartbeat> {
        let rows = self
            .rpc(
                "report_progress",
                json!({
                    "p_job_id": job_id,
                    "p_lease_token": lease_token,
                    "p_progress": progress.clamp(0.0, 1.0),
                    // The column is capped at 500 characters and a longer value would be
                    // silently cut by the function, so it is cut here where the intent is
                    // visible.
                    "p_message": message.chars().take(500).collect::<String>(),
                    "p_state": state,
                    "p_lease_seconds": self.lease_seconds,
                }),
            )
            .await?;
        let first = rows
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| ControlError::LeaseLost("report_progress returned no row".into()))?;
        serde_json::from_value(first).map_err(|e| {
            ControlError::Transport(format!(
                "report_progress row does not match the contract: {e}"
            ))
        })
    }

    /// Report the outcome, hand over the artifacts and meter the seconds, in one
    /// transaction. Render seconds are reported for a failed and a cancelled take too,
    /// because the fleet burned them either way.
    pub async fn complete_job(
        &self,
        job_id: &str,
        lease_token: &str,
        outcome: Outcome,
        render_seconds: f64,
        artifacts: &[ArtifactRef],
        error: Option<Value>,
    ) -> Result<Completion> {
        let rows = self
            .rpc(
                "complete_job",
                json!({
                    "p_job_id": job_id,
                    "p_lease_token": lease_token,
                    "p_outcome": outcome.as_str(),
                    "p_render_seconds": render_seconds.max(0.0),
                    "p_artifacts": artifacts,
                    "p_error": error,
                }),
            )
            .await?;
        let first = rows
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .ok_or_else(|| ControlError::LeaseLost("complete_job returned no row".into()))?;
        serde_json::from_value(first).map_err(|e| {
            ControlError::Transport(format!("complete_job row does not match the contract: {e}"))
        })
    }
}

/// The error object the API hands back to the customer.
///
/// `code` is one of the worker set codes named in docs/API.md and is stable enough to
/// branch on. `retryable` is read by `complete_job`: leaving it out means retryable, which
/// is the right default for a render box, so it is only ever set to false deliberately.
pub fn job_error(code: &str, message: &str, retryable: bool, detail: Option<Value>) -> Value {
    let mut v = json!({
        "code": code,
        // Truncated because the message goes into a jsonb column that the API returns
        // verbatim, and a page can make the recorder produce an arbitrarily long one.
        "message": message.chars().take(1000).collect::<String>(),
        "retryable": retryable,
    });
    if let Some(d) = detail {
        v["detail"] = d;
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_error_without_an_explicit_retryable_would_be_retried_so_we_always_set_it() {
        let e = job_error("op_failed", "selector matched nothing", false, None);
        assert_eq!(e["retryable"], serde_json::json!(false));
        // complete_job reads exactly this field, and coalesces a missing one to true.
        assert!(e.get("retryable").is_some());
    }

    #[test]
    fn the_outcome_strings_are_the_three_complete_job_accepts() {
        assert_eq!(Outcome::Done.as_str(), "done");
        assert_eq!(Outcome::Failed.as_str(), "failed");
        assert_eq!(Outcome::Cancelled.as_str(), "cancelled");
    }

    #[test]
    fn a_lease_row_parses_into_what_the_job_loop_expects() {
        let row = serde_json::json!({
            "job_id": "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44",
            "org_id": "0d1b2c3d-0000-4000-8000-000000000001",
            "project_id": "0d1b2c3d-0000-4000-8000-000000000002",
            "lease_token": "0d1b2c3d-0000-4000-8000-000000000003",
            "lease_expires_at": "2026-09-23T11:06:02.481Z",
            "attempt": 1,
            "max_attempts": 3,
            "script": [{"op": "navigate", "url": "https://kaviri.dev"}],
            "options": {"preset": "readme"},
            "max_job_seconds": 1800
        });
        let lease: Lease = serde_json::from_value(row).expect("the contract row must parse");
        assert_eq!(lease.attempt, 1);
        assert_eq!(lease.ops().expect("an array").len(), 1);
    }
}
