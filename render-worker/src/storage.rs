//! Putting the MP4 in R2.
//!
//! The worker uploads the object and only then calls `complete_job`. That order is the
//! whole design: an artifact row pointing at an object that does not exist is a 404 on the
//! link a customer put in their README, whereas an object with no row is a sweep's
//! problem and costs storage until the sweep runs.
//!
//! SigV4 is implemented here rather than pulled in as an SDK because the worker needs
//! exactly one operation, PutObject, against exactly one endpoint. An SDK for that is a
//! large dependency tree on a box that runs customer scripts, and the signing algorithm is
//! forty lines that never change.

use crate::config::Config;
use chrono::Utc;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncReadExt;

type HmacSha256 = Hmac<Sha256>;

/// R2 is region-less and its SigV4 implementation expects this literal in the credential
/// scope. It is not a placeholder for a real region, which is why it is the default rather
/// than something derived. Any other S3-compatible endpoint, Supabase Storage included, wants
/// its own region and sets KAVIRI_S3_REGION.
pub const DEFAULT_REGION: &str = "auto";
const SERVICE: &str = "s3";

pub struct Storage {
    http: reqwest::Client,
    endpoint: String,
    region: String,
    bucket: String,
    access_key_id: String,
    secret_access_key: String,
}

/// A file as it exists in the bucket, and everything the artifact row needs about it.
pub struct Stored {
    pub storage_key: String,
    pub bytes: u64,
    pub sha256_hex: String,
}

impl Storage {
    pub fn new(cfg: &Config) -> Result<Storage, String> {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            // No overall timeout. An upload is minutes of streaming for a long take, and a
            // request timeout here would cut a take that was succeeding. The wall clock
            // supervisor around the job is what bounds this.
            .user_agent(concat!("kaviri-render-worker/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("cannot build an HTTP client: {e}"))?;
        Ok(Storage {
            http,
            endpoint: cfg.s3_endpoint.clone(),
            region: cfg.s3_region.clone(),
            bucket: cfg.r2_bucket.clone(),
            access_key_id: cfg.r2_access_key_id.clone(),
            secret_access_key: cfg.r2_secret_access_key.clone(),
        })
    }

    /// Rounds a retention in days up to the class that names a prefix in the bucket.
    ///
    /// This is the Rust half of `retentionClassFor` in `workers/dl/src/keys.ts` and the
    /// two must agree value for value. Rounding up rather than down because an object
    /// must never be swept before the retention the customer was promised, and a null or
    /// non-positive retention means unlimited, which has no lifecycle rule at all.
    pub fn retention_class(days: Option<i32>) -> &'static str {
        match days {
            None => "keep",
            Some(d) if d <= 0 => "keep",
            Some(d) if d <= 7 => "d7",
            Some(d) if d <= 30 => "d30",
            Some(d) if d <= 90 => "d90",
            Some(d) if d <= 365 => "d365",
            _ => "keep",
        }
    }

    /// Where a job's artifact of a given kind lives.
    ///
    ///   a/<class>/<org id>/<job id>/<kind>.<ext>
    ///
    /// The layout is not ours to choose: it is the contract in `workers/dl/src/keys.ts`,
    /// which the download Worker parses and which the R2 lifecycle rules filter on. The
    /// retention class has to be in the key because an R2 lifecycle rule can match a
    /// prefix and nothing else, so an object written outside this shape is both
    /// undownloadable and never swept.
    ///
    /// Stable across attempts on purpose. A retry that re-renders the same take overwrites
    /// the object rather than writing a second one, which matches `complete_job`'s
    /// `on conflict (job_id, kind) do update` and means a failed attempt cannot leave an
    /// object in the bucket that no row points at.
    pub fn key_for(
        org_id: &str,
        job_id: &str,
        retention_days: Option<i32>,
        kind: &str,
        extension: &str,
    ) -> String {
        let class = Self::retention_class(retention_days);
        format!(
            "a/{class}/{}/{}/{kind}.{extension}",
            org_id.to_ascii_lowercase(),
            job_id.to_ascii_lowercase()
        )
    }

    pub async fn put_file(
        &self,
        key: &str,
        path: &Path,
        content_type: &str,
    ) -> Result<Stored, String> {
        let meta = tokio::fs::metadata(path)
            .await
            .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
        let len = meta.len();
        if len == 0 {
            return Err("refusing to upload a zero byte object".into());
        }

        // Hashed by streaming the file rather than by reading it into memory, because a
        // long take is gigabytes and the box is also running a browser. The digest is
        // needed twice: SigV4 signs it, and the artifact row carries it so a corrupted
        // download can be told from a corrupted render.
        let sha256_hex = sha256_file(path).await?;

        let file = tokio::fs::File::open(path)
            .await
            .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        let body = reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::new(file));

        let canonical_uri = format!("/{}/{}", self.bucket, uri_encode_path(key));
        let host = self
            .endpoint
            .strip_prefix("https://")
            .unwrap_or(&self.endpoint)
            .to_string();
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();

        // The signed headers, in the order SigV4 requires: lowercased names, sorted.
        let canonical_headers = format!(
            "content-length:{len}\ncontent-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{sha256_hex}\nx-amz-date:{amz_date}\n"
        );
        let signed_headers = "content-length;content-type;host;x-amz-content-sha256;x-amz-date";
        let canonical_request =
            format!("PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{sha256_hex}");

        let scope = format!("{date_stamp}/{}/{SERVICE}/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            hex::encode(Sha256::digest(canonical_request.as_bytes()))
        );
        let signature = hex::encode(sign(
            &signing_key(&self.secret_access_key, &date_stamp, &self.region),
            string_to_sign.as_bytes(),
        ));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key_id
        );

        let res = self
            .http
            .put(format!("{}{canonical_uri}", self.endpoint))
            .header("host", &host)
            .header("content-length", len)
            .header("content-type", content_type)
            .header("x-amz-content-sha256", &sha256_hex)
            .header("x-amz-date", &amz_date)
            .header("authorization", authorization)
            .body(body)
            .send()
            .await
            .map_err(|e| format!("uploading {key}: {e}"))?;

        if !res.status().is_success() {
            let status = res.status();
            // The body of an S3 error is XML naming the problem, and it is ours rather
            // than the customer's, so it is safe to log. Truncated because a proxy in the
            // way can return an HTML page instead.
            let body: String = res
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(400)
                .collect();
            return Err(format!("uploading {key} failed with {status}: {body}"));
        }

        Ok(Stored {
            storage_key: key.to_string(),
            bytes: len,
            sha256_hex,
        })
    }
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn sign(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

fn signing_key(secret: &str, date_stamp: &str, region: &str) -> Vec<u8> {
    let k_date = sign(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let k_region = sign(&k_date, region.as_bytes());
    let k_service = sign(&k_region, SERVICE.as_bytes());
    sign(&k_service, b"aws4_request")
}

/// Percent encode a key for the canonical URI.
///
/// The slashes between path segments stay as slashes, and everything outside the unreserved
/// set is encoded, which is what SigV4 signs. Our keys are UUIDs and fixed filenames, so in
/// practice nothing is encoded at all; the function exists so that the day a key carries a
/// customer supplied name the signature still matches the request.
fn uri_encode_path(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for b in key.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_is_stable_across_attempts_so_a_retry_overwrites_rather_than_accumulates() {
        let org = "8f14e45f-ceea-467a-9e35-7a2bd0a3c8d1";
        let job = "4a2c1f9e-6b3d-4e21-9a77-0c5b8d2f1e44";
        let a = Storage::key_for(org, job, Some(30), "video", "mp4");
        let b = Storage::key_for(org, job, Some(30), "video", "mp4");
        assert_eq!(a, b);
        assert_eq!(a, format!("a/d30/{org}/{job}/video.mp4"));
    }

    #[test]
    fn the_retention_class_rounds_up_and_matches_the_download_worker() {
        // These are the values in workers/dl/src/keys.ts. A disagreement here writes
        // objects under a prefix no lifecycle rule matches, so the bucket never shrinks.
        assert_eq!(Storage::retention_class(Some(1)), "d7");
        assert_eq!(Storage::retention_class(Some(7)), "d7");
        assert_eq!(Storage::retention_class(Some(8)), "d30");
        assert_eq!(Storage::retention_class(Some(30)), "d30");
        assert_eq!(Storage::retention_class(Some(90)), "d90");
        assert_eq!(Storage::retention_class(Some(365)), "d365");
        assert_eq!(Storage::retention_class(Some(366)), "keep");
        assert_eq!(Storage::retention_class(None), "keep");
        assert_eq!(Storage::retention_class(Some(0)), "keep");
    }

    #[test]
    fn path_separators_survive_encoding_and_spaces_do_not() {
        assert_eq!(
            uri_encode_path("orgs/a/jobs/b/take.mp4"),
            "orgs/a/jobs/b/take.mp4"
        );
        assert_eq!(uri_encode_path("a b"), "a%20b");
        assert_eq!(uri_encode_path("a+b"), "a%2Bb");
    }

    #[test]
    fn the_signing_key_chain_matches_the_documented_sigv4_derivation() {
        // The published AWS test vector for the key derivation, which is the one part of
        // this that is easy to get subtly wrong and impossible to debug from a 403.
        let key = {
            let k_date = sign(b"AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", b"20150830");
            let k_region = sign(&k_date, b"us-east-1");
            let k_service = sign(&k_region, b"iam");
            sign(&k_service, b"aws4_request")
        };
        assert_eq!(
            hex::encode(key),
            "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9"
        );
    }
}
