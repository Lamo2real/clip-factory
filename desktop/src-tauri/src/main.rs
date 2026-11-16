// No console window next to the app on Windows (release builds only, so debug output stays visible).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Clip Factory desktop: one native window that shows the deployed web app (docs/CONTRACTS.md §12.3).
//! It bundles no web UI: updates come from the website itself, so this wrapper rarely changes.

use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
use tauri::{Theme, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The deployed app, baked in by build.rs from `CF_APP_URL`.
const APP_URL: &str = env!("CF_APP_URL_RESOLVED");

/// Runs before the page's own scripts on every load: marks the wrapper and sends links to other sites outward.
const INIT_SCRIPT: &str = include_str!("init.js");

const WINDOW_LABEL: &str = "main";
const TITLE: &str = "Clip Factory";
const MIN_SIZE: (f64, f64) = (380.0, 600.0);
const START_SIZE: (f64, f64) = (1200.0, 820.0);

/// The light tint laid into the native glass (Clip Factory off-white, a little over half strength). Only the
/// Windows `Blur` path is known to honour it: Windows 11 22H2+ acrylic drops the colour (window-vibrancy sets only
/// the system backdrop type there), macOS 11-15 vibrancy takes none, and macOS 26 Liquid Glass is unproven. So the
/// web page assumes black behind every glass except `blur` (web/src/lib/background.ts `glassFloor`, §22.3), and
/// works out the tint over black from these same numbers (`GLASS_TINT_ALPHA`); keep the two in step.
const GLASS_TINT: Color = Color(247, 245, 239, 140);

/// The native see-through material behind the page (docs/CONTRACTS.md §22). The web app reads its name from
/// `window.__CF_GLASS__` and turns its own background transparent only when it is not `none`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Glass {
    /// macOS: Liquid Glass on macOS 26 and newer, the under-window vibrancy material before that.
    Vibrancy,
    /// Windows 11 22H2 and newer: blurred acrylic, shows soft shapes of what is behind.
    Acrylic,
    /// Windows 10 1809 to Windows 11 21H2: blur behind, smooth there (acrylic lags while dragging on those builds).
    Blur,
    /// Anything else (Linux, older Windows): a normal window; the web app draws its own background.
    None,
}

impl Glass {
    /// What this computer can draw: `mac` for macOS, or the Windows build number (None off Windows).
    fn for_os(mac: bool, windows_build: Option<u32>) -> Glass {
        match windows_build {
            _ if mac => Glass::Vibrancy,
            Some(build) if build >= 22621 => Glass::Acrylic,
            Some(build) if build >= 17763 => Glass::Blur,
            _ => Glass::None,
        }
    }

    fn here() -> Glass {
        Glass::for_os(cfg!(target_os = "macos"), windows_build())
    }

    /// The value of `window.__CF_GLASS__`.
    fn name(self) -> &'static str {
        match self {
            Glass::Vibrancy => "vibrancy",
            Glass::Acrylic => "acrylic",
            Glass::Blur => "blur",
            Glass::None => "none",
        }
    }

    /// The native effects for the window; None keeps an ordinary opaque window.
    fn effects(self) -> Option<EffectsBuilder> {
        let effects: &[Effect] = match self {
            // Tauri tries Liquid Glass first and falls back to the vibrancy material on macOS 15 and older.
            Glass::Vibrancy => &[Effect::LiquidGlassRegular, Effect::UnderWindowBackground],
            Glass::Acrylic => &[Effect::Acrylic],
            Glass::Blur => &[Effect::Blur],
            Glass::None => return None,
        };
        Some(
            EffectsBuilder::new()
                .effects(effects.iter().copied())
                // Stays glassy when another app is in front, instead of turning flat grey.
                .state(EffectState::Active)
                .color(GLASS_TINT),
        )
    }
}

#[cfg(windows)]
fn windows_build() -> Option<u32> {
    Some(windows_version::OsVersion::current().build)
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

/// The injected script, led by the glass this window has.
fn init_script(glass: Glass) -> String {
    format!("window.__CF_GLASS__ = \"{}\";\n{INIT_SCRIPT}", glass.name())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Saves size, position and maximized state on close and restores them when the window is created.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let app_url = Url::parse(APP_URL)?;
            let handle = app.handle().clone();
            let home = app_url.clone();
            let glass = Glass::here();

            let mut window =
                WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(app_url))
                    .title(TITLE)
                    .inner_size(START_SIZE.0, START_SIZE.1)
                    .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                    .center()
                    // The web app is drawn light, so the glass behind it is the light material too (§22.3).
                    .theme(Some(Theme::Light))
                    .user_agent(&user_agent())
                    .initialization_script(init_script(glass));
            if let Some(effects) = glass.effects() {
                window = window.transparent(true).effects(effects.build());
            }
            window
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
    fn glass_follows_what_the_computer_can_draw() {
        assert_eq!(Glass::for_os(true, None), Glass::Vibrancy);
        assert_eq!(Glass::for_os(false, Some(26100)), Glass::Acrylic);
        assert_eq!(Glass::for_os(false, Some(22621)), Glass::Acrylic);
        assert_eq!(Glass::for_os(false, Some(22000)), Glass::Blur);
        assert_eq!(Glass::for_os(false, Some(19045)), Glass::Blur);
        assert_eq!(Glass::for_os(false, Some(17134)), Glass::None);
        assert_eq!(Glass::for_os(false, None), Glass::None);
        assert!(Glass::None.effects().is_none());
        assert!(Glass::Acrylic.effects().is_some());
    }

    #[test]
    fn the_script_names_the_glass_first() {
        let script = init_script(Glass::Acrylic);
        assert!(script.starts_with("window.__CF_GLASS__ = \"acrylic\";\n"));
        assert!(script.contains("window.__CF_DESKTOP__ = true"));
    }

    #[test]
    fn user_agent_names_the_wrapper() {
        assert!(user_agent().contains(" ClipFactoryDesktop/"));
    }
}
