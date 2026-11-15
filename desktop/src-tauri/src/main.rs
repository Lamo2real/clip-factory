// No console window next to the app on Windows (release builds only, so debug output stays visible).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Clip Factory desktop: one native window that shows the deployed web app (docs/CONTRACTS.md §12.3).
//! It bundles no web UI: updates come from the website itself, so this wrapper rarely changes.

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The deployed app, baked in by build.rs from `CF_APP_URL`.
const APP_URL: &str = env!("CF_APP_URL_RESOLVED");

/// Runs before the page's own scripts on every load: marks the wrapper and sends links to other sites outward.
const INIT_SCRIPT: &str = include_str!("init.js");

const WINDOW_LABEL: &str = "main";
const TITLE: &str = "Clip Factory";
const MIN_SIZE: (f64, f64) = (380.0, 600.0);
const START_SIZE: (f64, f64) = (1200.0, 820.0);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Saves size, position and maximized state on close and restores them when the window is created.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let app_url = Url::parse(APP_URL)?;
            let handle = app.handle().clone();
            let home = app_url.clone();

            WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(app_url))
                .title(TITLE)
                .inner_size(START_SIZE.0, START_SIZE.1)
                .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                .center()
                .user_agent(&user_agent())
                .initialization_script(INIT_SCRIPT)
                .on_navigation(move |url| {
                    if stays_inside(&home, url) {
                        return true;
                    }
                    if opens_outside(url) {
                        if let Err(err) = handle.opener().open_url(url.as_str(), None::<&str>) {
                            eprintln!("could not open {url} in the system browser: {err}");
                        }
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Clip Factory could not start");
}

/// Pages of the app itself, plus the blank and in-memory pages the web view uses internally.
fn stays_inside(home: &Url, url: &Url) -> bool {
    url.origin() == home.origin() || matches!(url.scheme(), "about" | "blob" | "data")
}

/// Links that belong in the system browser or mail app. Anything else (file:, custom schemes) is dropped.
fn opens_outside(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

/// The web app hides "Get the app" when the user agent contains `ClipFactoryDesktop` (§12.1). Web views offer
/// no "append to the default", so this is a full user agent in the usual shape for the platform's engine.
fn user_agent() -> String {
    let version = env!("CARGO_PKG_VERSION");
    let base = if cfg!(target_os = "macos") {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    } else if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 \
         Safari/537.36 Edg/130.0.0.0"
    } else {
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)"
    };
    format!("{base} ClipFactoryDesktop/{version}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn app_pages_stay_inside() {
        let home = url("https://d1.cloudfront.net/");
        assert!(stays_inside(
            &home,
            &url("https://d1.cloudfront.net/library?x=1")
        ));
        assert!(stays_inside(&home, &url("about:blank")));
        assert!(!stays_inside(
            &home,
            &url("https://www.youtube.com/watch?v=1")
        ));
        assert!(!stays_inside(&home, &url("http://d1.cloudfront.net/")));
    }

    #[test]
    fn only_web_and_mail_links_open_outside() {
        assert!(opens_outside(&url("https://example.com/")));
        assert!(opens_outside(&url("mailto:a@example.com")));
        assert!(!opens_outside(&url("file:///etc/passwd")));
        assert!(!opens_outside(&url("ms-settings:privacy")));
    }

    #[test]
    fn user_agent_names_the_wrapper() {
        assert!(user_agent().contains(" ClipFactoryDesktop/"));
    }
}
