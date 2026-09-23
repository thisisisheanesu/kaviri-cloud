//! Turning a stored job into the newline-delimited JSON file the recorder reads, and
//! refusing the takes that are not takes.
//!
//! The edge already validates a script before the job is queued. This module validates it
//! again, and that duplication is deliberate. The edge protects the customer from their
//! own typo; this protects the box from the customer. They are different threats, they
//! will be edited by different people, and the day somebody adds a submission path that
//! forgets to call the edge validator, the thing standing between a script and the
//! metadata endpoint should not be a Worker in another repository.

use crate::redact;
use serde_json::Value;
use std::net::{IpAddr, Ipv4Addr};

/// How much of an unrecognised op name is quoted back. Long enough that an operator reading
/// the rejection can see the typo, short enough that the name cannot itself be the payload.
const OP_NAME_IN_ERROR: usize = 40;

/// Ops the service supplies itself. A script that names them is accepted by the API and
/// dropped here: the recorder starts a take when the first op runs and renders when the
/// script ends, and `--out` overrides any path in the file anyway, so carrying them
/// through would let a mid script `stop_recording` end the take early with the rest of the
/// ops running against a browser nobody is filming.
const SERVICE_OWNED: &[&str] = &["start_recording", "stop_recording"];

const ALLOWED_OPS: &[&str] = &["navigate", "click", "type", "scroll", "wait", "mark"];

/// Why a script cannot be filmed on this fleet. Every one of these is `retryable: false`
/// at the call site: filming it again changes nothing.
#[derive(Debug)]
pub struct Rejection {
    pub op_index: usize,
    pub reason: String,
}

/// The script, ready to write, and how many ops the recorder will actually execute.
pub struct Prepared {
    pub ndjson: String,
    pub ops: Vec<Value>,
}

pub fn prepare(script: &[Value]) -> Result<Prepared, Rejection> {
    let mut ops: Vec<Value> = Vec::with_capacity(script.len());
    for (i, op) in script.iter().enumerate() {
        let kind = op
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| Rejection {
                op_index: i,
                reason: "op is missing a string \"op\" field".into(),
            })?;

        if SERVICE_OWNED.contains(&kind) {
            continue;
        }
        if !ALLOWED_OPS.contains(&kind) {
            // The op name is quoted back because a typo is the overwhelmingly common cause
            // and "unknown op" with no name is unactionable. It is bounded first because
            // the name is a customer supplied string of unbounded length that travels from
            // here into the worker's log, the job row and the API response, and none of
            // those three is a place where an arbitrary megabyte belongs.
            return Err(Rejection {
                op_index: i,
                reason: format!(
                    "unknown op: {}",
                    redact::token_for_log(kind, OP_NAME_IN_ERROR)
                ),
            });
        }
        if kind == "navigate" {
            let url = op
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| Rejection {
                    op_index: i,
                    reason: "navigate is missing a string url".into(),
                })?;
            check_url(url).map_err(|reason| Rejection {
                op_index: i,
                reason,
            })?;
        }
        if kind == "wait" && op.get("ms").is_some() && op.get("selector").is_some() {
            return Err(Rejection {
                op_index: i,
                reason: "wait takes ms or selector, never both".into(),
            });
        }
        // An op serialised onto its own line must not contain one. serde_json escapes a
        // newline inside a string, so this can only happen if something upstream handed us
        // a pre-serialised line, and a second line in the file is a second op nobody
        // validated.
        let line = serde_json::to_string(op).map_err(|e| Rejection {
            op_index: i,
            reason: format!("op is not serialisable: {e}"),
        })?;
        if line.contains('\n') {
            return Err(Rejection {
                op_index: i,
                reason: "op serialises to more than one line".into(),
            });
        }
        ops.push(op.clone());
    }

    if ops.is_empty() {
        return Err(Rejection {
            op_index: 0,
            reason: "the script has no ops the recorder would execute".into(),
        });
    }

    let ndjson = ops
        .iter()
        .map(|o| serde_json::to_string(o).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    Ok(Prepared { ndjson, ops })
}

/// What a navigate may point at on a shared fleet.
///
/// The self hosted recorder happily opens `file://`, and it should: it is your machine and
/// your files. On our boxes it is somebody else reading `/etc/passwd` out of a container
/// image, and `http://169.254.169.254/` is somebody reading the cloud credentials of the
/// host. This is the one place the hosted service is deliberately stricter than the
/// recorder, and docs/API.md says so.
pub fn check_url(raw: &str) -> Result<(), String> {
    let u = url::Url::parse(raw).map_err(|e| format!("navigate url does not parse: {e}"))?;
    match u.scheme() {
        "http" | "https" => {}
        other => return Err(format!("navigate url must be http or https, not {other}")),
    }
    // Matched on url::Host rather than parsing host_str(), because host_str() hands back
    // an IPv6 literal still wrapped in its brackets ("[::1]"), which never parses as an
    // IpAddr. Parsing that string sent every IPv6 address down the domain-name path
    // instead of the address path, so ::1 and ::ffff:169.254.169.254 were both allowed
    // through a fence built precisely to refuse them.
    let host = match u.host() {
        Some(h) => h,
        None => return Err("navigate url has no host".into()),
    };

    let name = match host {
        url::Host::Ipv4(v4) => {
            if !is_public_ip(&IpAddr::V4(v4)) {
                return Err("navigate url points at a non-routable address".into());
            }
            return Ok(());
        }
        url::Host::Ipv6(v6) => {
            if !is_public_ip(&IpAddr::V6(v6)) {
                return Err("navigate url points at a non-routable address".into());
            }
            return Ok(());
        }
        url::Host::Domain(d) => d,
    };

    let lower = name.to_ascii_lowercase();
    let blocked_suffix = [
        ".internal",
        ".local",
        ".localhost",
        ".localdomain",
        ".cluster.local",
    ];
    let blocked_exact = ["localhost", "metadata", "metadata.goog", "instance-data"];
    if blocked_exact.contains(&lower.as_str()) || blocked_suffix.iter().any(|s| lower.ends_with(s))
    {
        return Err("navigate url points at an internal name".into());
    }
    Ok(())
}

/// Whether an address is one a customer's page may reach.
///
/// Written as an allow list of "not one of these ranges" rather than a deny list of a few
/// famous addresses, because 169.254.169.254 is only the most famous member of a family:
/// the Hetzner private network, the Docker bridge and the host's own loopback are all
/// reachable from a container and none of them is a take.
fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            // An IPv4 mapped address is an IPv4 address wearing a hat, and blocking the
            // v4 form while allowing ::ffff:169.254.169.254 would be theatre.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_v4(&mapped);
            }
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return false;
            }
            let s = v6.segments();
            let unique_local = (s[0] & 0xfe00) == 0xfc00;
            let link_local = (s[0] & 0xffc0) == 0xfe80;
            !(unique_local || link_local)
        }
    }
}

fn is_public_v4(ip: &Ipv4Addr) -> bool {
    let o = ip.octets();
    if ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip.is_documentation()
    {
        return false;
    }
    // Carrier grade NAT, 100.64.0.0/10. Hetzner and most clouds put internal services
    // here, and the standard library has no predicate for it.
    if o[0] == 100 && (64..=127).contains(&o[1]) {
        return false;
    }
    // Benchmarking, 198.18.0.0/15, and the reserved 240.0.0.0/4.
    if (o[0] == 198 && (o[1] == 18 || o[1] == 19)) || o[0] >= 240 {
        return false;
    }
    // IETF protocol assignments, 192.0.0.0/24.
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return false;
    }
    true
}

/// A best effort guess at what a mid script failure was, from the recorder's own error
/// text, so the customer gets a stable code rather than prose that may be reworded.
/// The codes are the worker set listed in docs/API.md.
pub fn classify_op_failure(error: &str) -> &'static str {
    let e = error.to_ascii_lowercase();
    if e.contains("navigate") && e.contains("timed out") {
        "navigate_timeout"
    } else if e.contains("timed out") || e.contains("timeout") {
        "selector_timeout"
    } else {
        "op_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_metadata_endpoint_is_not_a_take() {
        assert!(check_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(check_url("http://[::ffff:169.254.169.254]/").is_err());
        assert!(check_url("http://metadata.google.internal/").is_err());
        assert!(check_url("http://metadata/computeMetadata/v1/").is_err());
    }

    #[test]
    fn the_internal_network_is_not_a_take_either() {
        for host in [
            "127.0.0.1",
            "10.0.0.5",
            "172.17.0.1",
            "192.168.1.1",
            "100.64.3.9",
            "[::1]",
        ] {
            assert!(
                check_url(&format!("http://{host}/")).is_err(),
                "{host} must be refused"
            );
        }
        assert!(check_url("http://db.internal/").is_err());
        assert!(check_url("http://localhost:8099/").is_err());
    }

    #[test]
    fn a_file_url_is_refused_here_although_the_recorder_would_open_it() {
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("data:text/html,<h1>hi").is_err());
    }

    #[test]
    fn an_ordinary_public_page_is_allowed() {
        assert!(check_url("https://kaviri.dev/docs?x=1").is_ok());
        assert!(check_url("http://93.184.216.34/").is_ok());
    }

    #[test]
    fn the_service_owns_start_and_stop_recording() {
        let script = vec![
            json!({"op": "start_recording", "path": "/somewhere/else.mp4"}),
            json!({"op": "navigate", "url": "https://kaviri.dev"}),
            json!({"op": "stop_recording"}),
        ];
        let prepared = prepare(&script).expect("this script is fine");
        assert_eq!(prepared.ops.len(), 1);
        assert!(!prepared.ndjson.contains("start_recording"));
        assert!(prepared.ndjson.ends_with('\n'));
    }

    #[test]
    fn a_script_of_nothing_but_service_ops_is_refused_rather_than_filmed() {
        let script = vec![
            json!({"op": "start_recording"}),
            json!({"op": "stop_recording"}),
        ];
        assert!(prepare(&script).is_err());
    }

    #[test]
    fn an_unknown_op_is_named_in_the_rejection_but_cannot_be_the_payload() {
        let huge: String = "z".repeat(1_000_000);
        let script = vec![json!({"op": huge})];
        match prepare(&script) {
            Err(err) => {
                assert!(err.reason.starts_with("unknown op: zzz"));
                assert!(
                    err.reason.chars().count() < 200,
                    "a megabyte of customer text reached the rejection: {} chars",
                    err.reason.chars().count()
                );
                assert!(err.reason.contains("1000000 chars total"));
            }
            Ok(_) => panic!("an op named by a megabyte of z must be refused"),
        }
    }

    #[test]
    fn a_wait_with_both_bounds_is_refused_the_way_the_recorder_refuses_it() {
        let script = vec![json!({"op": "wait", "ms": 500, "selector": ".x"})];
        // Matched rather than unwrapped with expect_err, because Prepared deliberately
        // does not derive Debug: it holds the customer's script, and the one thing this
        // crate does not want is a formatting impl that can put that in a panic message.
        match prepare(&script) {
            Err(err) => assert_eq!(err.op_index, 0),
            Ok(_) => panic!("a wait carrying both ms and selector must be refused"),
        }
    }
}
