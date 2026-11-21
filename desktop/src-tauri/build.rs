//! Bakes the address of the deployed web app into the binary.
//!
//! `CF_APP_URL` (Terraform output `app_url`) is read at build time. A release build without it fails, so a
//! wrapper that points nowhere can never be shipped. Debug builds fall back to the local Vite dev server.

use std::env;

const DEV_URL: &str = "http://localhost:5173/";

fn main() {
    println!("cargo:rerun-if-env-changed=CF_APP_URL");

    let release = env::var("PROFILE").is_ok_and(|p| p == "release");
    let raw = env::var("CF_APP_URL").unwrap_or_default();
    let raw = raw.trim();

    let app_url = if raw.is_empty() {
        if release {
            panic!(
                "CF_APP_URL is not set. Set it to the deployed app address (Terraform output app_url), \
                 for example CF_APP_URL=https://d111111abcdef8.cloudfront.net"
            );
        }
        DEV_URL.to_owned()
    } else {
        validate(raw)
    };

    println!("cargo:rustc-env=CF_APP_URL_RESOLVED={app_url}");

    // Mac fetches it (docs/CONTRACTS.md §35.3): the one host the app sends a video's parts to, the media bucket's
    // regional address (`<bucket>.s3.<region>.amazonaws.com`). A release build without it fails, like CF_APP_URL.
    println!("cargo:rerun-if-env-changed=CF_MEDIA_HOST");
    let media = env::var("CF_MEDIA_HOST").unwrap_or_default();
    let media = media.trim();
    if media.is_empty() && release {
        panic!(
            "CF_MEDIA_HOST is not set. Set it to the media bucket's regional host, for example \
             CF_MEDIA_HOST=cf-prod-media-123.s3.eu-north-1.amazonaws.com"
        );
    }
    if !media.is_empty() && !media_host_ok(media) {
        panic!("CF_MEDIA_HOST {media:?} is not <bucket>.s3.<region>.amazonaws.com");
    }
    println!("cargo:rustc-env=CF_MEDIA_HOST_RESOLVED={media}");

    // The page may call exactly these app commands, and only through the runtime capabilities main.rs adds for the
    // app's own address (mac_fetch::capability, cr_connect::capability). capabilities/main.json grants none of them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "mac_fetch_start",
            "mac_fetch_status",
            "mac_fetch_upload",
            "mac_fetch_cancel",
            // Connect Content Rewards (docs/CONTRACTS.md §38.15): the one-time sign-in door.
            "cr_connect_listen",
            "cr_connect_open",
            "cr_connect_result",
            "cr_connect_cancel",
        ]),
    ))
    .expect("tauri build step");
}

/// A virtual-hosted S3 address on a regional endpoint: lower-case bucket name, nothing else.
fn media_host_ok(host: &str) -> bool {
    let Some((bucket, rest)) = host.split_once(".s3.") else {
        return false;
    };
    let Some(region) = rest.strip_suffix(".amazonaws.com") else {
        return false;
    };
    let bucket_ok = (3..=63).contains(&bucket.len())
        && bucket
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.');
    let region_ok = !region.is_empty()
        && region
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    bucket_ok && region_ok
}

/// Accepts https anywhere, and plain http only for this machine (local development).
fn validate(raw: &str) -> String {
    let url = url::Url::parse(raw)
        .unwrap_or_else(|e| panic!("CF_APP_URL {raw:?} is not a valid address: {e}"));
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    match url.scheme() {
        "https" => {}
        "http" if local => {}
        other => panic!("CF_APP_URL must use https (http only for localhost), got {other}://"),
    }
    if url.host_str().is_none_or(str::is_empty) {
        panic!("CF_APP_URL {raw:?} has no host");
    }
    // Only the origin matters: the web app is a single-page app served from the root.
    url.origin().ascii_serialization() + "/"
}
