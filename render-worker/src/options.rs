//! The job's `options` column, turned into a recorder command line.
//!
//! Every flag here exists in `kaviri/src/main.rs`, and the allowed values are the
//! recorder's own. Nothing is invented: a flag the recorder does not have is a usage error
//! that exits 2 before the browser starts, which would surface to the customer as a
//! render failure with no footage and no explanation.
//!
//! Order matters. The recorder applies a preset where it reads it and lets a later
//! `--width` or `--scale` win, so the preset goes first and the explicit overrides follow.

use serde_json::Value;

const PRESETS: &[&str] = &[
    "desktop",
    "tiktok",
    "reels",
    "shorts",
    "square",
    "landscape",
    "readme",
    "phone",
];
const BACKGROUNDS: &[&str] = &[
    "auto",
    "none",
    "dusk",
    "dawn",
    "tide",
    "moss",
    "ember",
    "slate",
    "linen",
    "mesh-cool",
    "mesh-warm",
];
const CURSORS: &[&str] = &["auto", "none", "arrow", "hand", "text"];

pub struct Resolved {
    pub args: Vec<String>,
    /// Whether the customer asked for the telemetry sidecar. It carries every navigate URL
    /// verbatim, including query strings, so it is produced only on request and is an
    /// artifact of its own rather than something the worker reads.
    pub telemetry: bool,
}

/// Build the recorder's arguments, or say which option is wrong.
///
/// A bad option reaching here means the edge let it through, so the error is reported
/// against the job as not retryable: the same options will be just as wrong next time.
pub fn resolve(options: &Value) -> Result<Resolved, String> {
    let mut args: Vec<String> = Vec::new();

    if let Some(preset) = string(options, "preset")? {
        if !PRESETS.contains(&preset.as_str()) {
            return Err(format!("unknown preset: {preset}"));
        }
        args.push("--preset".into());
        args.push(preset);
    }
    if let Some(background) = string(options, "background")? {
        if !BACKGROUNDS.contains(&background.as_str()) {
            return Err(format!("unknown background: {background}"));
        }
        args.push("--background".into());
        args.push(background);
    }
    if let Some(scale) = number(options, "scale", 0.5, 4.0)? {
        args.push("--scale".into());
        args.push(format_number(scale));
    }
    if let Some(w) = integer(options, "out_width", 64, 8192)? {
        args.push("--out-width".into());
        args.push(w.to_string());
    }
    if let Some(h) = integer(options, "out_height", 64, 8192)? {
        args.push("--out-height".into());
        args.push(h.to_string());
    }
    if let Some(cursor) = string(options, "cursor")? {
        if !CURSORS.contains(&cursor.as_str()) {
            return Err(format!("unknown cursor: {cursor}"));
        }
        args.push("--cursor".into());
        args.push(cursor);
    }
    if let Some(cs) = number(options, "cursor_scale", 0.2, 8.0)? {
        args.push("--cursor-scale".into());
        args.push(format_number(cs));
    }

    let telemetry = match options.get("telemetry") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("telemetry must be true or false".into()),
    };

    Ok(Resolved { args, telemetry })
}

/// A string option, or nothing. An explicit JSON null means "the recorder's default",
/// which is how the API documents `out_width: null`, so it is not an error.
fn string(options: &Value, key: &str) -> Result<Option<String>, String> {
    match options.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim().to_ascii_lowercase())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn number(options: &Value, key: &str, lo: f64, hi: f64) -> Result<Option<f64>, String> {
    match options.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = v
                .as_f64()
                .ok_or_else(|| format!("{key} must be a number"))?;
            if !n.is_finite() || !(lo..=hi).contains(&n) {
                return Err(format!("{key} must be between {lo} and {hi}"));
            }
            Ok(Some(n))
        }
    }
}

fn integer(options: &Value, key: &str, lo: i64, hi: i64) -> Result<Option<i64>, String> {
    match options.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let n = v
                .as_i64()
                .ok_or_else(|| format!("{key} must be a whole number"))?;
            if !(lo..=hi).contains(&n) {
                return Err(format!("{key} must be between {lo} and {hi}"));
            }
            Ok(Some(n))
        }
    }
}

/// Format without an exponent and without a trailing `.0`, because the recorder parses
/// these with `str::parse::<f64>` and a value like `1e0` is legal there but unreadable in
/// a `ps` listing when somebody is trying to work out what a box is doing.
fn format_number(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n:.3}")
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_preset_comes_before_the_overrides_that_are_supposed_to_beat_it() {
        let r = resolve(&json!({"preset": "tiktok", "scale": 1})).expect("valid");
        let preset_at = r.args.iter().position(|a| a == "--preset").expect("preset");
        let scale_at = r.args.iter().position(|a| a == "--scale").expect("scale");
        assert!(preset_at < scale_at, "the recorder applies flags in order");
    }

    #[test]
    fn an_explicit_null_means_the_default_rather_than_an_error() {
        let r = resolve(&json!({"out_width": null, "out_height": null})).expect("valid");
        assert!(r.args.is_empty());
    }

    #[test]
    fn a_value_the_recorder_would_reject_is_rejected_here_instead() {
        assert!(resolve(&json!({"preset": "vertical"})).is_err());
        assert!(resolve(&json!({"background": "rainbow"})).is_err());
        assert!(resolve(&json!({"scale": 9})).is_err());
        assert!(resolve(&json!({"out_width": 10})).is_err());
        assert!(resolve(&json!({"cursor": "crosshair"})).is_err());
    }

    #[test]
    fn a_whole_number_scale_is_written_without_a_decimal_point() {
        assert_eq!(format_number(2.0), "2");
        assert_eq!(format_number(2.5), "2.5");
        assert_eq!(format_number(1.75), "1.75");
    }

    #[test]
    fn telemetry_is_off_unless_it_is_asked_for() {
        assert!(!resolve(&json!({})).expect("valid").telemetry);
        assert!(
            resolve(&json!({"telemetry": true}))
                .expect("valid")
                .telemetry
        );
        assert!(resolve(&json!({"telemetry": "yes"})).is_err());
    }
}
