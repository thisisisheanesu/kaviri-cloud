//! A script is customer data, and the worker's log is not.
//!
//! A kaviri script is a list of things to type into a page. Sooner or later one of them is
//! a password, because somebody recorded a login demo against a staging account and pasted
//! the real credential. A navigate URL is the same problem in a different shape: a signed
//! preview link or a session token in a query string. Neither may reach our log stream,
//! our metrics, or an error we hand to an on call engineer, so redaction happens here and
//! every log site in this crate goes through it.
//!
//! The rule is allow listing, not pattern matching. A redactor that looks for things that
//! resemble secrets misses the one that does not resemble anything, and the cost of being
//! wrong is a customer's password in a log aggregator that retains for a year. So a value
//! is logged only when its own field has been decided to be safe, and everything else is
//! reduced to its shape.

use serde_json::Value;

/// One op, rendered for a log line: enough to tell an engineer where a take went wrong,
/// and nothing that could be a credential.
///
/// `{"op":"type","selector":"#pw","text":"hunter2"}` becomes `type #pw (7 chars)`. The
/// length is kept because "the typing op failed" and "the typing op typed nothing" are
/// different bugs, and a length is not a secret.
pub fn op_for_log(op: &Value) -> String {
    let kind = op.get("op").and_then(Value::as_str).unwrap_or("?");
    match kind {
        "navigate" => {
            let url = op.get("url").and_then(Value::as_str).unwrap_or("");
            format!("navigate {}", url_for_log(url))
        }
        "type" => {
            let n = op
                .get("text")
                .and_then(Value::as_str)
                .map(str::chars)
                .map(Iterator::count)
                .unwrap_or(0);
            match op.get("selector").and_then(Value::as_str) {
                Some(sel) => format!("type {} ({n} chars)", selector_for_log(sel)),
                None => format!("type into the focused element ({n} chars)"),
            }
        }
        "click" | "wait" | "scroll" | "mark" => {
            let target = op
                .get("selector")
                .and_then(Value::as_str)
                .map(selector_for_log)
                .unwrap_or_default();
            format!("{kind} {target}").trim_end().to_string()
        }
        other => other.to_string(),
    }
}

/// Scheme, host and the number of path segments. The path itself and the whole query
/// string are dropped: a signed URL puts its credential in the query, and a preview link
/// puts it in the path.
pub fn url_for_log(raw: &str) -> String {
    match url::Url::parse(raw) {
        Ok(u) => {
            let segments = u.path().split('/').filter(|s| !s.is_empty()).count();
            let query = if u.query().is_some() {
                ", query redacted"
            } else {
                ""
            };
            format!(
                "{}://{}/[{} path segment(s){}]",
                u.scheme(),
                u.host_str().unwrap_or("?"),
                segments,
                query
            )
        }
        // An unparseable URL is not necessarily harmless: it may be a malformed data: URI
        // with a payload in it, so it is reported by length rather than by content.
        Err(_) => format!("[unparseable url, {} chars]", raw.chars().count()),
    }
}

/// A selector is structural rather than secret, but it can carry a value in an attribute
/// predicate, so anything long or quoted is shortened rather than printed whole.
pub fn selector_for_log(sel: &str) -> String {
    let flat: String = sel.chars().filter(|c| !c.is_control()).collect();
    if flat.len() > 80 || flat.contains('"') || flat.contains('\'') {
        format!("[selector, {} chars]", flat.chars().count())
    } else {
        flat
    }
}

/// A whole script, summarised. Used once per job at info level, because knowing a take was
/// 31 ops of which 9 were navigations is the difference between reading a timeout as
/// normal and reading it as broken.
pub fn script_shape(script: &[Value]) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for op in script {
        let kind = op.get("op").and_then(Value::as_str).unwrap_or("?");
        match counts.iter_mut().find(|(k, _)| *k == kind) {
            Some((_, n)) => *n += 1,
            None => counts.push((kind, 1)),
        }
    }
    counts.sort_by_key(|a| std::cmp::Reverse(a.1));
    let body: Vec<String> = counts.iter().map(|(k, n)| format!("{n} {k}")).collect();
    format!("{} ops: {}", script.len(), body.join(", "))
}

/// A line the recorder wrote to stderr, on its way to our log.
///
/// The recorder is not trying to leak anything, but it does echo what it was asked to do,
/// and what it was asked to do came from the customer. Anything quoted or URL shaped is
/// cut out, and the line is truncated, because a page can make the recorder print an
/// arbitrarily long error by giving an element an arbitrarily long id.
pub fn line_for_log(line: &str) -> String {
    let mut out = String::with_capacity(line.len().min(400));
    let mut in_quote = false;
    let mut words = line.split_whitespace().peekable();
    while let Some(word) = words.next() {
        let cleaned = if word.contains("://") || word.starts_with("file:") {
            url_for_log(word.trim_matches(|c| c == '"' || c == '\'' || c == ','))
        } else if word.contains('"') || word.contains('\'') {
            in_quote = !in_quote;
            "[quoted]".to_string()
        } else if in_quote {
            continue;
        } else {
            word.to_string()
        };
        if out.len() + cleaned.len() > 400 {
            out.push_str(" [truncated]");
            break;
        }
        out.push_str(&cleaned);
        if words.peek().is_some() {
            out.push(' ');
        }
    }
    out
}

// There was a `field_is_loggable` deny list here. It is deliberately gone: nothing called
// it, and a deny list sitting in a redaction module is a trap, because the next person to
// need this reaches for it and gets exactly the pattern matching the module header rules
// out. Every value logged from here is named explicitly by the match arms above.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_typed_password_never_survives_a_log_line() {
        let op = json!({"op": "type", "selector": "#password", "text": "correct horse battery"});
        let line = op_for_log(&op);
        assert!(!line.contains("correct"));
        assert!(!line.contains("horse"));
        // The length is kept, because typing nothing and typing the wrong thing are
        // different failures and neither is a secret.
        assert!(line.contains("21 chars"));
    }

    #[test]
    fn a_signed_url_loses_its_signature() {
        let logged = url_for_log("https://app.example.com/preview/abc?X-Amz-Signature=deadbeef");
        assert!(!logged.contains("deadbeef"));
        assert!(!logged.contains("abc"));
        assert!(logged.contains("app.example.com"));
        assert!(logged.contains("query redacted"));
    }

    #[test]
    fn a_recorder_line_carrying_a_url_is_cleaned_rather_than_dropped() {
        let line = line_for_log("kaviri: navigate https://x.test/a/b?t=secret timed out after 25s");
        assert!(!line.contains("secret"));
        assert!(line.contains("timed out"));
        assert!(line.contains("x.test"));
    }

    #[test]
    fn a_field_named_in_no_match_arm_contributes_nothing_to_the_line() {
        // The allow list is the match in op_for_log, so the test of it is that an op
        // carrying an unanticipated field logs the field's absence rather than its value.
        let op = json!({"op": "click", "selector": "#go", "authorization": "Bearer hunter2"});
        let line = op_for_log(&op);
        assert!(line.contains("#go"));
        assert!(!line.contains("hunter2"));
        assert!(!line.to_ascii_lowercase().contains("authorization"));
    }
}
