// No console window next to the app on Windows (release builds only, so debug output stays visible).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Clip Factory desktop: one native window that shows the deployed web app (docs/CONTRACTS.md §12.3).
//! It bundles no web UI: the pages update from the website itself, and the wrapper updates itself (update.rs).

mod cr_connect;
mod mac_fetch;
mod update;

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::window::{Color, Effect, EffectState, EffectsBuilder};
use tauri::{Manager, RunEvent, Theme, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// The deployed app, baked in by build.rs from `CF_APP_URL`.
const APP_URL: &str = env!("CF_APP_URL_RESOLVED");

/// Runs before the page's own scripts on every load: marks the wrapper and sends links to other sites outward.
const INIT_SCRIPT: &str = include_str!("init.js");

const WINDOW_LABEL: &str = "main";
const TITLE: &str = "Clip Factory";
const MIN_SIZE: (f64, f64) = (380.0, 600.0);
const START_SIZE: (f64, f64) = (1200.0, 820.0);

/// The height, in points, of the macOS title bar band that lies over the page (docs/CONTRACTS.md §12.3, §11.1).
/// The window's title bar is transparent and its title hidden, so the traffic lights float on the app's own glass;
/// the page keeps this band clear (`window.__CF_TITLEBAR__`, read by web/src/lib/look.ts) and starts every column
/// below it. 28 is the standard AppKit title bar; if a macOS release makes it taller, only this number changes.
const MAC_TITLEBAR_HEIGHT: u32 = 28;

/// The band the page keeps clear on this system: the overlay title bar on macOS, nothing elsewhere (Windows and
/// Linux keep their normal window frame, which sits outside the page).
fn titlebar_height() -> u32 {
    if cfg!(target_os = "macos") {
        MAC_TITLEBAR_HEIGHT
    } else {
        0
    }
}

/// The tint laid into the native glass (Clip Factory bottle green, a little over half strength), so the gaps between
/// the panels look green while the window is in use.
/// - macOS 26 and newer (Liquid Glass) honours it while the window is in use (measured on macOS 27.2 on 2026-11-16
///   with the earlier light tint). While another app is in use the system drops the tint for a neutral light grey.
/// - The Windows `Blur` path honours it (worked out, not measured).
/// - Windows 11 22H2+ acrylic drops the colour (window-vibrancy sets only the system backdrop type there) and the
///   vibrancy material of macOS 15 and older takes none.
///
/// The web page's text is bone on bottle-green panels, so it plans for the lightest each glass can be: white
/// (web/src/lib/background.ts `glassCeiling`, §22.3). This tint can only make the glass darker, so readability never
/// depends on it. `glassFloor` uses this tint over black for `blur` (`GLASS_TINT_ALPHA`). Keep the two in step.
const GLASS_TINT: Color = Color(15, 55, 43, 140);

/// The AppKit version from which macOS draws Liquid Glass (macOS 26.0). It is the number window-vibrancy 0.8
/// checks before it applies the effect (its `MIN_APPKIT_VERSION_LIQUID_GLASS`); on anything older Tauri falls back
/// to the next effect in the list, the under-window vibrancy material. A test pins the window-vibrancy version, so
/// an update asks for a fresh look at this number.
const MIN_APPKIT_VERSION_LIQUID_GLASS: f64 = 2685.0;

/// The native see-through material behind the page (docs/CONTRACTS.md §22). The web app reads its name from
/// `window.__CF_GLASS__` and turns its own background transparent only when it is not `none`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Glass {
    /// macOS 26 and newer: Liquid Glass.
    Liquid,
    /// macOS 15 and older: the under-window vibrancy material.
    Vibrancy,
    /// Windows 11 22H2 and newer: blurred acrylic, shows soft shapes of what is behind.
    Acrylic,
    /// Windows 10 1809 to Windows 11 21H2: blur behind, smooth there (acrylic lags while dragging on those builds).
    Blur,
    /// Anything else (Linux, older Windows): a normal window; the web app draws its own background.
    None,
}

impl Glass {
    /// What this computer can draw: AppKit's version number on macOS (None anywhere else), or the Windows build
    /// number (None off Windows).
    fn for_os(appkit_version: Option<f64>, windows_build: Option<u32>) -> Glass {
        match (appkit_version, windows_build) {
            (Some(version), _) => Glass::for_appkit(version),
            (None, Some(build)) if build >= 22621 => Glass::Acrylic,
            (None, Some(build)) if build >= 17763 => Glass::Blur,
            _ => Glass::None,
        }
    }

    /// Which glass macOS draws for the effects below. The same test window-vibrancy makes: an AppKit older than
    /// `MIN_APPKIT_VERSION_LIQUID_GLASS` has no Liquid Glass, so the vibrancy material is used.
    fn for_appkit(version: f64) -> Glass {
        if version < MIN_APPKIT_VERSION_LIQUID_GLASS {
            Glass::Vibrancy
        } else {
            Glass::Liquid
        }
    }

    fn here() -> Glass {
        Glass::for_os(appkit_version(), windows_build())
    }

    /// The value of `window.__CF_GLASS__`.
    fn name(self) -> &'static str {
        match self {
            Glass::Liquid => "liquid",
            Glass::Vibrancy => "vibrancy",
            Glass::Acrylic => "acrylic",
            Glass::Blur => "blur",
            Glass::None => "none",
        }
    }

    /// The native effects for the window; None keeps an ordinary opaque window.
    fn effects(self) -> Option<EffectsBuilder> {
        let effects: &[Effect] = match self {
            // One list for every Mac: Tauri tries Liquid Glass first and falls back to the vibrancy material on
            // macOS 15 and older. `for_appkit` only tells the page which of the two it got.
            Glass::Liquid | Glass::Vibrancy => {
                &[Effect::LiquidGlassRegular, Effect::UnderWindowBackground]
            }
            Glass::Acrylic => &[Effect::Acrylic],
            Glass::Blur => &[Effect::Blur],
            Glass::None => return None,
        };
        Some(
            EffectsBuilder::new()
                .effects(effects.iter().copied())
                // The vibrancy material stays glassy when another app is in front, instead of turning flat grey.
                // (Liquid Glass has no such switch: it stays glass, but drops the tint then, §22.3.)
                .state(EffectState::Active)
                .color(GLASS_TINT),
        )
    }
}

/// AppKit's own version number: what Tauri and window-vibrancy go by when they choose between Liquid Glass and
/// the older vibrancy material.
#[cfg(target_os = "macos")]
fn appkit_version() -> Option<f64> {
    // The one `unsafe` item in this crate (Cargo.toml denies the rest). AppKit exports this constant `double`
    // (NSApplication.h). The app always links AppKit, because its window is an AppKit window, and nothing ever
    // writes to the constant, so reading it is sound.
    #[allow(unsafe_code)]
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        safe static NSAppKitVersionNumber: f64;
    }
    Some(NSAppKitVersionNumber)
}

#[cfg(not(target_os = "macos"))]
fn appkit_version() -> Option<f64> {
    None
}

#[cfg(windows)]
fn windows_build() -> Option<u32> {
    Some(windows_version::OsVersion::current().build)
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

/// The injected script, led by the glass this window has, the version of this app (`window.__CF_DESKTOP_VERSION__`,
/// so the page can tell copies apart, §12.6) and the title bar band the page must keep clear (§11.1).
fn init_script(glass: Glass, version: &str, titlebar: u32) -> String {
    format!(
        "window.__CF_GLASS__ = \"{}\";\nwindow.__CF_DESKTOP_VERSION__ = \"{}\";\nwindow.__CF_TITLEBAR__ = {titlebar};\n{INIT_SCRIPT}",
        glass.name(),
        safe_version(version)
    )
}

/// The one native permission the remote page gets: dragging the window by its title bar band, and zooming it with a
/// double click there (Tauri's drag script, `data-tauri-drag-region`), for this app's own address only, in the main
/// window only. Without it the overlay title bar could not move the window. Everything else stays denied
/// (capabilities/main.json).
fn drag_capability(app_url: &Url) -> tauri::ipc::CapabilityBuilder {
    tauri::ipc::CapabilityBuilder::new("title-bar-drag")
        .remote(format!("{}/*", app_url.origin().ascii_serialization()))
        .local(false)
        .window(WINDOW_LABEL)
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize")
}

/// The app version as it goes into the script: semver characters only, anything else becomes "unknown".
fn safe_version(version: &str) -> &str {
    let ok = !version.is_empty()
        && version.len() <= 64
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if ok {
        version
    } else {
        "unknown"
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Saves size, position and maximized state on close and restores them when the window is created.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // The update check and its one "Restart now / Later" question run from Rust only (update.rs); the page gets
        // no access to either (capabilities/main.json stays empty).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(update::LaterInstall::default())
        // Mac fetches it (§35): the page's four commands, granted below to the app's own address only.
        .manage(mac_fetch::Fetches::default())
        // Connect Content Rewards (§38.15): the one-time sign-in door and its four commands, granted below to the
        // app's own address only. Off macOS they answer `unsupported`.
        .manage(cr_connect::CrConnect::default())
        .invoke_handler(tauri::generate_handler![
            mac_fetch::mac_fetch_start,
            mac_fetch::mac_fetch_status,
            mac_fetch::mac_fetch_upload,
            mac_fetch::mac_fetch_cancel,
            cr_connect::cr_connect_listen,
            cr_connect::cr_connect_open,
            cr_connect::cr_connect_result,
            cr_connect::cr_connect_cancel
        ])
        .setup(|app| {
            let app_url = Url::parse(APP_URL)?;
            let handle = app.handle().clone();
            let home = app_url.clone();
            let glass = Glass::here();
            let version = app.package_info().version.to_string();
            app.add_capability(drag_capability(&app_url))?;
            app.add_capability(mac_fetch::capability(&app_url, WINDOW_LABEL))?;
            app.add_capability(cr_connect::capability(&app_url, WINDOW_LABEL))?;
            // Videos left on this computer by a job that never finished are cleared at start-up.
            mac_fetch::sweep(app.handle());

            let mut window =
                WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(app_url))
                    .title(TITLE)
                    .inner_size(START_SIZE.0, START_SIZE.1)
                    .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
                    .center()
                    // The light material, as measured (§22.3): the web app's green panels are worked out for the
                    // lightest glass, so a dark material would only darken them. Not switched without a measurement.
                    .theme(Some(Theme::Light))
                    .user_agent(&user_agent(&version))
                    // Ask takes pictures dropped on it (§26). Tauri's own drop handler is on by default and keeps file
                    // drops from the page, so it is turned off: the page handles drops, and drops anywhere else are
                    // ignored by the page (web/src/features/help/HelpLauncher.tsx).
                    .disable_drag_drop_handler()
                    // The page drives Mac fetches with timers (the 30 s look at the jobs, the 1 s poll, the
                    // progress reports). A window that is minimized or covered must not have them slowed or
                    // paused, or a job started from the phone would wait while the app sits behind other windows.
                    .background_throttling(BackgroundThrottlingPolicy::Disabled)
                    .initialization_script(init_script(glass, &version, titlebar_height()));
            // macOS: the title bar is laid over the page, clear and without its title, so there is no white strip and
            // the traffic lights float on the app's own glass (the page keeps their band clear, §11.1). The title
            // still names the window in the Dock, Mission Control and the Window menu.
            #[cfg(target_os = "macos")]
            {
                window = window
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
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
            update::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Clip Factory could not start");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            update::install_on_exit(app);
        }
    });
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
fn user_agent(version: &str) -> String {
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
        // The page's "Update the app" link for copies too old to update themselves (web/src/lib/device.ts
        // oldAppDownloadUrl): the same server with a trailing dot is another site, so it opens in the system browser,
        // which can download it. The rule has not changed since the first wrapper, so old copies do the same.
        let update = url("https://d1.cloudfront.net./downloads/Clip-Factory.dmg");
        assert!(!stays_inside(&home, &update));
        assert!(opens_outside(&update));
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
        assert_eq!(Glass::for_os(None, Some(26100)), Glass::Acrylic);
        assert_eq!(Glass::for_os(None, Some(22621)), Glass::Acrylic);
        assert_eq!(Glass::for_os(None, Some(22000)), Glass::Blur);
        assert_eq!(Glass::for_os(None, Some(19045)), Glass::Blur);
        assert_eq!(Glass::for_os(None, Some(17134)), Glass::None);
        assert_eq!(Glass::for_os(None, None), Glass::None);
        // A Mac is a Mac whatever else is claimed.
        assert_eq!(Glass::for_os(Some(2685.0), Some(26100)), Glass::Liquid);
        assert!(Glass::None.effects().is_none());
        assert!(Glass::Acrylic.effects().is_some());
        assert!(Glass::Blur.effects().is_some());
    }

    #[test]
    fn a_mac_reports_liquid_glass_from_macos_26_and_vibrancy_before() {
        // AppKit 2685 is macOS 26.0: the first with Liquid Glass (window-vibrancy's own threshold).
        assert_eq!(Glass::for_appkit(2685.0), Glass::Liquid);
        assert_eq!(Glass::for_appkit(2685.1), Glass::Liquid);
        assert_eq!(Glass::for_appkit(2800.0), Glass::Liquid);
        assert_eq!(Glass::for_appkit(2684.9), Glass::Vibrancy);
        // macOS 15 (AppKit 2575), 14 (2487) and 11 (2022).
        for older in [2575.7, 2487.2, 2022.0] {
            assert_eq!(Glass::for_appkit(older), Glass::Vibrancy);
            assert_eq!(Glass::for_os(Some(older), None), Glass::Vibrancy);
        }
        assert_eq!(Glass::for_os(Some(2685.0), None), Glass::Liquid);
        // Both ask Tauri for the same effects; only the name the page reads differs.
        assert!(Glass::Liquid.effects().is_some());
        assert!(Glass::Vibrancy.effects().is_some());
        assert_eq!(Glass::Liquid.name(), "liquid");
        assert_eq!(Glass::Vibrancy.name(), "vibrancy");
    }

    #[test]
    fn the_liquid_glass_threshold_is_the_one_of_the_window_vibrancy_in_use() {
        // The number is copied from window-vibrancy 0.8 (src/macos/liquid_glass.rs). If this fails after an
        // update, read `MIN_APPKIT_VERSION_LIQUID_GLASS` in the new version and bring both in step.
        assert_eq!(MIN_APPKIT_VERSION_LIQUID_GLASS, 2685.0);
        let lock = include_str!("../Cargo.lock");
        // Line by line, so a checkout with Windows line endings reads the same.
        let mut lines = lock.lines().map(str::trim);
        assert!(
            lines.any(|line| line == "name = \"window-vibrancy\""),
            "window-vibrancy is in Cargo.lock"
        );
        let version = lines.next().expect("a version line after the name");
        assert!(
            version.starts_with("version = \"0.8."),
            "window-vibrancy {version}"
        );
    }

    #[test]
    fn this_computer_reports_a_glass_that_fits_it() {
        let glass = Glass::here();
        if cfg!(target_os = "macos") {
            let version = appkit_version().expect("AppKit's version on a Mac");
            assert!(version > 1000.0, "AppKit version {version}");
            assert_eq!(glass, Glass::for_appkit(version));
        } else {
            assert_eq!(appkit_version(), None);
            assert!(!matches!(glass, Glass::Liquid | Glass::Vibrancy));
        }
        if !cfg!(windows) {
            assert!(!matches!(glass, Glass::Acrylic | Glass::Blur));
        }
    }

    #[test]
    fn the_script_names_the_glass_first() {
        for (glass, name) in [
            (Glass::Liquid, "liquid"),
            (Glass::Vibrancy, "vibrancy"),
            (Glass::Acrylic, "acrylic"),
            (Glass::Blur, "blur"),
            (Glass::None, "none"),
        ] {
            let script = init_script(glass, "1.42.0", 28);
            assert!(script.starts_with(&format!(
                "window.__CF_GLASS__ = \"{name}\";\nwindow.__CF_DESKTOP_VERSION__ = \"1.42.0\";\nwindow.__CF_TITLEBAR__ = 28;\n"
            )));
            assert!(script.contains("window.__CF_DESKTOP__ = true"));
            // The Content Rewards sign-in bridge (§38.15), version 1, with its four commands only.
            assert!(script.contains("window.__CF_CR_CONNECT__ = Object.freeze({\n    version: 1,"));
            for command in [
                "cr_connect_listen",
                "cr_connect_open",
                "cr_connect_result",
                "cr_connect_cancel",
            ] {
                assert!(script.contains(&format!("\"{command}\"")), "{command}");
            }
            // Its errors reach the page as one of the four codes only, Tauri's own refusals too.
            assert!(script
                .contains("var CR_CODES = [\"no_port\", \"bad_url\", \"unsupported\", \"busy\"];"));
            assert!(script.contains(
                "return Promise.reject(known ? { code: e.code } : { code: \"unsupported\" });"
            ));
        }
    }

    #[test]
    fn the_version_in_the_script_is_plain_semver() {
        assert_eq!(safe_version("1.42.0"), "1.42.0");
        assert_eq!(safe_version("1.0.0-beta.1+abc"), "1.0.0-beta.1+abc");
        assert_eq!(safe_version(""), "unknown");
        assert_eq!(safe_version("1\";alert(1);\""), "unknown");
        assert_eq!(safe_version("1.0.0\n"), "unknown");
        let script = init_script(Glass::None, "</script>", 0);
        assert!(script.contains("window.__CF_DESKTOP_VERSION__ = \"unknown\";"));
    }

    #[test]
    fn the_page_keeps_the_mac_title_bar_band_clear_and_nothing_elsewhere() {
        if cfg!(target_os = "macos") {
            assert_eq!(titlebar_height(), 28);
        } else {
            assert_eq!(titlebar_height(), 0);
        }
        assert!(init_script(Glass::None, "1.42.0", 0).contains("window.__CF_TITLEBAR__ = 0;\n"));
    }

    #[test]
    fn only_the_app_itself_may_drag_the_window_and_nothing_more() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        let CapabilityFile::Capability(cap) =
            drag_capability(&url("https://d1.cloudfront.net/")).build()
        else {
            panic!("one capability");
        };
        assert_eq!(cap.identifier, "title-bar-drag");
        assert!(!cap.local, "only the remote app, never a local page");
        assert_eq!(cap.windows, vec![WINDOW_LABEL.to_owned()]);
        let remote = cap.remote.expect("a remote capability");
        assert_eq!(remote.urls, vec!["https://d1.cloudfront.net/*".to_owned()]);
        // Exactly the two window permissions: no files, shell, opener or anything else.
        let perms = format!("{:?}", cap.permissions);
        assert_eq!(cap.permissions.len(), 2, "{perms}");
        assert!(perms.contains("allow-start-dragging"), "{perms}");
        assert!(perms.contains("allow-internal-toggle-maximize"), "{perms}");
    }

    #[test]
    fn user_agent_names_the_wrapper() {
        assert!(user_agent("1.42.0").ends_with(" ClipFactoryDesktop/1.42.0"));
    }
}
