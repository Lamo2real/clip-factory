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
    tauri_build::build();
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
