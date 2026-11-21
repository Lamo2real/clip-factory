//! Connect Content Rewards: the one-time sign-in door (docs/CONTRACTS.md §38.15, ADR-62). Content Rewards only
//! sends a sign-in back to `http://127.0.0.1`, so for one sign-in the Mac app opens a tiny door on this computer.
//! It never sees a token: it hands the one-time code to its own page (web/src/lib/crConnect.ts), which posts it to
//! the API at once. Four commands, granted only to the app's own address in the main window (`capability`):
//!
//! * `cr_connect_listen {}` → `{port, expiresAt}`: opens the door on the first free port of 47811–47815 (door.rs),
//!   for 5 minutes. A new listen closes the old door.
//! * `cr_connect_open {url}` → `{}`: checks the sign-in address (check.rs), remembers its `state` and opens it in the
//!   system browser.
//! * `cr_connect_result {}` → `{status: "none" | "waiting" | "done" | "error" | "expired", code?, state?, iss?,
//!   error?, errorDescription?}`: the answer, handed over once.
//! * `cr_connect_cancel {}` → `{}`: closes the door.
//!
//! Command errors are `{code: "no_port" | "bad_url" | "unsupported" | "busy"}`. The door is built for macOS only;
//! elsewhere the bridge exists but `listen` and `open` answer `unsupported` (Windows can let another program take a
//! known port, and the owner's computer is a Mac).

// The door is built for macOS only; elsewhere these files are built for their tests alone, and the commands
// below answer `unsupported`, so much of this module is never used there.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(any(target_os = "macos", test))]
pub mod check;
#[cfg(any(target_os = "macos", test))]
pub mod door;

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url};

/// The commands the page may call, as the capability names them.
pub const PERMISSIONS: [&str; 4] = [
    "allow-cr-connect-listen",
    "allow-cr-connect-open",
    "allow-cr-connect-result",
    "allow-cr-connect-cancel",
];

/// A command error, as the page reads it: `{code}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum CmdError {
    /// No port of the five was free, no door is open, or the browser could not be opened.
    NoPort,
    /// The sign-in address was not Content Rewards' own, for this door.
    BadUrl,
    /// This computer does not open the door (not macOS).
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    Unsupported,
    /// This door was already opened for a sign-in.
    Busy,
}

/// `cr_connect_listen`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listening {
    pub port: u16,
    /// When the door closes, as an ISO 8601 UTC time ("2026-11-21T12:39:56.000Z").
    pub expires_at: String,
}

/// `cr_connect_open`'s and `cr_connect_cancel`'s answer: `{}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Nothing {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// No door is open (never opened, closed, or its answer already handed over).
    None,
    /// The door is open and no answer came yet.
    Waiting,
    /// Content Rewards sent a code: `code`, `state` (and `iss` when it sent one).
    Done,
    /// Content Rewards sent an error: `error`, `state` (and `errorDescription`, `iss` when it sent them).
    Error,
    /// Five minutes went by without an answer.
    Expired,
}

/// `cr_connect_result`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrResult {
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iss: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_description: Option<String>,
}

impl CrResult {
    fn just(status: Status) -> CrResult {
        CrResult {
            status,
            code: None,
            state: None,
            iss: None,
            error: None,
            error_description: None,
        }
    }
}

/// The four operations over at most one open door, free of Tauri so every rule has a test. The commands below use
/// it on macOS only.
#[cfg(any(target_os = "macos", test))]
pub struct Bridge {
    door: std::sync::Mutex<Option<door::Door>>,
    config: door::Config,
}

#[cfg(any(target_os = "macos", test))]
impl Bridge {
    pub fn new(config: door::Config) -> Bridge {
        Bridge {
            door: std::sync::Mutex::new(None),
            config,
        }
    }

    fn slot(&self) -> std::sync::MutexGuard<'_, Option<door::Door>> {
        self.door.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Closes any open door, then opens a new one. `on_answer` runs once after a good answer.
    pub fn listen(
        &self,
        on_answer: impl Fn() + Send + Sync + 'static,
    ) -> Result<Listening, CmdError> {
        let mut slot = self.slot();
        // The old door is dropped first, so its port is free again for this one.
        *slot = None;
        let opened =
            door::Door::open(&self.config, Box::new(on_answer)).map_err(|_| CmdError::NoPort)?;
        let listening = Listening {
            port: opened.port(),
            expires_at: iso(std::time::SystemTime::now() + self.config.open_for),
        };
        *slot = Some(opened);
        Ok(listening)
    }

    /// Checks `url` for the open door, remembers its `state` and hands it to `browser` (which says whether it opened).
    pub fn open(&self, url: &str, browser: impl FnOnce(&str) -> bool) -> Result<Nothing, CmdError> {
        let mut slot = self.slot();
        let open = slot.as_ref().ok_or(CmdError::NoPort)?;
        if open.expired() {
            return Err(CmdError::NoPort);
        }
        let checked = check::authorize_url(url, open.port()).map_err(|_| CmdError::BadUrl)?;
        open.expect(checked.state).map_err(|_| CmdError::Busy)?;
        if !browser(&checked.url) {
            // Nothing will come back through this door.
            *slot = None;
            return Err(CmdError::NoPort);
        }
        Ok(Nothing {})
    }

    /// The door's answer, handed over once; after it the door is closed and the status is `none`.
    pub fn result(&self) -> CrResult {
        let mut slot = self.slot();
        let Some(open) = slot.as_ref() else {
            return CrResult::just(Status::None);
        };
        match open.read() {
            door::Reading::Waiting => CrResult::just(Status::Waiting),
            door::Reading::Expired => CrResult::just(Status::Expired),
            door::Reading::Answered(answer) => {
                *slot = None;
                let mut out = CrResult::just(Status::Done);
                out.state = Some(answer.state);
                out.iss = answer.iss;
                match answer.kind {
                    door::Kind::Code(code) => out.code = Some(code),
                    door::Kind::Error { error, description } => {
                        out.status = Status::Error;
                        out.error = Some(error);
                        out.error_description = description;
                    }
                }
                out
            }
        }
    }

    /// Closes the door, if one is open.
    pub fn cancel(&self) -> Nothing {
        *self.slot() = None;
        Nothing {}
    }
}

/// The app's state for the four commands.
#[cfg(target_os = "macos")]
pub struct CrConnect(Bridge);

#[cfg(target_os = "macos")]
impl Default for CrConnect {
    fn default() -> Self {
        CrConnect(Bridge::new(door::Config::default()))
    }
}

#[cfg(target_os = "macos")]
impl CrConnect {
    fn listen(&self, on_answer: impl Fn() + Send + Sync + 'static) -> Result<Listening, CmdError> {
        self.0.listen(on_answer)
    }
    fn open(&self, url: &str, browser: impl FnOnce(&str) -> bool) -> Result<Nothing, CmdError> {
        self.0.open(url, browser)
    }
    fn result(&self) -> CrResult {
        self.0.result()
    }
    fn cancel(&self) -> Nothing {
        self.0.cancel()
    }
}

/// Off macOS the bridge is there, but there is never a door.
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct CrConnect {}

#[cfg(not(target_os = "macos"))]
impl CrConnect {
    fn listen(&self, _on_answer: impl Fn() + Send + Sync + 'static) -> Result<Listening, CmdError> {
        Err(CmdError::Unsupported)
    }
    fn open(&self, _url: &str, _browser: impl FnOnce(&str) -> bool) -> Result<Nothing, CmdError> {
        Err(CmdError::Unsupported)
    }
    fn result(&self) -> CrResult {
        CrResult::just(Status::None)
    }
    fn cancel(&self) -> Nothing {
        Nothing {}
    }
}

/// After a good answer: the Clip Factory window comes back to the front, so the owner sees what happened. macOS may
/// refuse to bring an app forward over the browser (or the window may still be coming out of the Dock), so the Dock
/// icon also bounces once; macOS skips that when the app is already in front.
fn bring_to_front(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(crate::WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

#[tauri::command]
pub fn cr_connect_listen(
    app: AppHandle,
    state: State<'_, CrConnect>,
) -> Result<Listening, CmdError> {
    state.listen(move || bring_to_front(&app))
}

#[tauri::command]
pub fn cr_connect_open(
    app: AppHandle,
    state: State<'_, CrConnect>,
    url: String,
) -> Result<Nothing, CmdError> {
    use tauri_plugin_opener::OpenerExt;
    state.open(&url, |checked| {
        let opened = app.opener().open_url(checked, None::<&str>);
        if opened.is_err() {
            // The address is not printed: it carries the sign-in's state.
            eprintln!("cr connect: could not open the system browser");
        }
        opened.is_ok()
    })
}

#[tauri::command]
pub fn cr_connect_result(state: State<'_, CrConnect>) -> CrResult {
    state.result()
}

#[tauri::command]
pub fn cr_connect_cancel(state: State<'_, CrConnect>) -> Nothing {
    state.cancel()
}

/// The page's grant for these four commands: the app's own address, in the main window, never a local page.
pub fn capability(app_url: &Url, window: &str) -> tauri::ipc::CapabilityBuilder {
    let mut cap = tauri::ipc::CapabilityBuilder::new("cr-connect")
        .remote(format!("{}/*", app_url.origin().ascii_serialization()))
        .local(false)
        .window(window);
    for p in PERMISSIONS {
        cap = cap.permission(p);
    }
    cap
}

/// `t` as an ISO 8601 UTC time with milliseconds, the way the web reads times (`new Date(...)`).
#[cfg(any(target_os = "macos", test))]
pub fn iso(t: std::time::SystemTime) -> String {
    let since = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

/// The calendar date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
#[cfg(any(target_os = "macos", test))]
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::check::tests::{url_with, STATE};
    use super::door::tests::{config, get, soon, spare_port, FakeClock, ANY_PORT};
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, UNIX_EPOCH};

    fn bridge() -> (Bridge, Arc<FakeClock>) {
        let clock = Arc::new(FakeClock::default());
        (Bridge::new(config(vec![ANY_PORT], clock.clone())), clock)
    }

    /// A pretend system browser that remembers what it was asked to open.
    fn browser(opened: &Mutex<Vec<String>>) -> impl FnOnce(&str) -> bool + '_ {
        move |url| {
            opened.lock().unwrap().push(url.to_owned());
            true
        }
    }

    #[test]
    fn the_whole_sign_in_hands_the_code_over_once() {
        let (bridge, _clock) = bridge();
        assert_eq!(bridge.result().status, Status::None);
        let fronts = Arc::new(AtomicUsize::new(0));
        let counted = fronts.clone();
        let listening = bridge
            .listen(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();
        assert_eq!(bridge.result().status, Status::Waiting);

        let opened = Mutex::new(Vec::new());
        let url = url_with(listening.port, &[]);
        assert_eq!(bridge.open(&url, browser(&opened)), Ok(Nothing {}));
        assert_eq!(opened.lock().unwrap().len(), 1);
        assert!(opened.lock().unwrap()[0].starts_with(check::AUTHORIZE));
        // Opened once per door.
        assert_eq!(bridge.open(&url, browser(&opened)), Err(CmdError::Busy));
        assert_eq!(opened.lock().unwrap().len(), 1);

        let page = get(listening.port, &format!("/?code=the-code&state={STATE}"));
        assert!(page.unwrap().starts_with("HTTP/1.1 200 OK"));
        let done = bridge.result();
        assert_eq!(
            serde_json::to_value(&done).unwrap(),
            serde_json::json!({"status": "done", "code": "the-code", "state": STATE})
        );
        // Once: then there is no door.
        assert_eq!(
            serde_json::to_value(bridge.result()).unwrap(),
            serde_json::json!({"status": "none"})
        );
        assert!(soon(|| fronts.load(Ordering::SeqCst) == 1));
    }

    #[test]
    fn an_error_comes_back_with_its_words_and_iss() {
        let (bridge, _clock) = bridge();
        let listening = bridge.listen(|| {}).unwrap();
        let opened = Mutex::new(Vec::new());
        bridge
            .open(&url_with(listening.port, &[]), browser(&opened))
            .unwrap();
        get(
            listening.port,
            &format!(
                "/?error=access_denied&error_description=Not%20allowed&state={STATE}&iss=https%3A%2F%2Fid.contentrewards.com"
            ),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(bridge.result()).unwrap(),
            serde_json::json!({
                "status": "error",
                "state": STATE,
                "iss": "https://id.contentrewards.com",
                "error": "access_denied",
                "errorDescription": "Not allowed",
            })
        );
        assert_eq!(bridge.result().status, Status::None);
    }

    #[test]
    fn open_checks_the_address_against_the_open_door() {
        let (bridge, _clock) = bridge();
        let opened = Mutex::new(Vec::new());
        // No door yet.
        assert_eq!(
            bridge.open(&url_with(47811, &[]), browser(&opened)),
            Err(CmdError::NoPort)
        );
        let listening = bridge.listen(|| {}).unwrap();
        // A way back to another port, another host, http: never opened.
        for bad in [
            url_with(listening.port.wrapping_add(1), &[]),
            url_with(listening.port, &[]).replace("https://id.", "https://evil."),
            url_with(listening.port, &[]).replace("https://", "http://"),
        ] {
            assert_eq!(
                bridge.open(&bad, browser(&opened)),
                Err(CmdError::BadUrl),
                "{bad}"
            );
        }
        assert!(opened.lock().unwrap().is_empty());
        // A bad address does not use the door up.
        assert_eq!(
            bridge.open(&url_with(listening.port, &[]), browser(&opened)),
            Ok(Nothing {})
        );
    }

    #[test]
    fn a_browser_that_will_not_open_closes_the_door() {
        let (bridge, _clock) = bridge();
        let listening = bridge.listen(|| {}).unwrap();
        assert_eq!(
            bridge.open(&url_with(listening.port, &[]), |_| false),
            Err(CmdError::NoPort)
        );
        assert_eq!(bridge.result().status, Status::None);
    }

    #[test]
    fn a_new_listen_closes_the_old_door_and_cancel_closes_it() {
        let clock = Arc::new(FakeClock::default());
        let only = spare_port();
        let bridge = Bridge::new(config(vec![only], clock));
        let first = bridge.listen(|| {}).unwrap();
        let second = bridge.listen(|| {}).unwrap();
        // One port only: the first door was closed before the second opened, so the same port came back.
        assert_eq!((first.port, second.port), (only, only));
        assert_eq!(bridge.result().status, Status::Waiting);
        assert_eq!(bridge.cancel(), Nothing {});
        assert_eq!(bridge.result().status, Status::None);
        assert!(std::net::TcpListener::bind(("127.0.0.1", second.port)).is_ok());
        assert_eq!(
            serde_json::to_value(bridge.cancel()).unwrap(),
            serde_json::json!({})
        );
    }

    #[test]
    fn after_five_minutes_the_result_is_expired_and_open_has_no_door() {
        let (bridge, clock) = bridge();
        let listening = bridge.listen(|| {}).unwrap();
        clock.advance(door::OPEN_FOR);
        assert_eq!(
            serde_json::to_value(bridge.result()).unwrap(),
            serde_json::json!({"status": "expired"})
        );
        assert_eq!(bridge.result().status, Status::Expired);
        let opened = Mutex::new(Vec::new());
        assert_eq!(
            bridge.open(&url_with(listening.port, &[]), browser(&opened)),
            Err(CmdError::NoPort)
        );
        assert!(opened.lock().unwrap().is_empty());
    }

    #[test]
    fn listen_says_when_the_door_closes() {
        let (bridge, _clock) = bridge();
        let before = std::time::SystemTime::now();
        let listening = bridge.listen(|| {}).unwrap();
        let json = serde_json::to_value(&listening).unwrap();
        assert_eq!(json["port"], listening.port);
        let at = json["expiresAt"].as_str().unwrap();
        assert_eq!(at.len(), "2026-11-21T12:34:56.000Z".len());
        assert!(at.ends_with('Z'));
        let earliest = iso(before + door::OPEN_FOR);
        let latest = iso(std::time::SystemTime::now() + door::OPEN_FOR);
        assert!(earliest.as_str() <= at && at <= latest.as_str(), "{at}");
    }

    #[test]
    fn no_port_when_every_port_is_taken() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let clock = Arc::new(FakeClock::default());
        let bridge = Bridge::new(config(vec![taken.local_addr().unwrap().port()], clock));
        assert_eq!(bridge.listen(|| {}), Err(CmdError::NoPort));
        assert_eq!(bridge.result().status, Status::None);
    }

    #[test]
    fn errors_are_the_codes_the_page_reads() {
        for (e, code) in [
            (CmdError::NoPort, "no_port"),
            (CmdError::BadUrl, "bad_url"),
            (CmdError::Unsupported, "unsupported"),
            (CmdError::Busy, "busy"),
        ] {
            assert_eq!(
                serde_json::to_value(e).unwrap(),
                serde_json::json!({ "code": code })
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn off_macos_listen_and_open_are_unsupported() {
        let cr = CrConnect {};
        assert_eq!(cr.listen(|| {}), Err(CmdError::Unsupported));
        assert_eq!(
            cr.open(&url_with(47811, &[]), |_| panic!("never opened")),
            Err(CmdError::Unsupported)
        );
        assert_eq!(cr.result().status, Status::None);
        assert_eq!(cr.cancel(), Nothing {});
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn on_a_mac_the_app_uses_the_five_real_ports() {
        let cr = CrConnect::default();
        assert_eq!(cr.0.config.ports, door::PORTS.to_vec());
        assert_eq!(cr.0.config.open_for, door::OPEN_FOR);
        assert_eq!(cr.result().status, Status::None);
        assert_eq!(cr.cancel(), Nothing {});
    }

    #[test]
    fn only_the_app_itself_may_sign_in_and_only_with_these_commands() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        let CapabilityFile::Capability(cap) =
            capability(&Url::parse("https://d1.cloudfront.net/").unwrap(), "main").build()
        else {
            panic!("one capability");
        };
        assert_eq!(cap.identifier, "cr-connect");
        assert!(!cap.local, "never a local page");
        assert_eq!(cap.windows, vec!["main".to_owned()]);
        assert_eq!(
            cap.remote.unwrap().urls,
            vec!["https://d1.cloudfront.net/*".to_owned()]
        );
        let perms = format!("{:?}", cap.permissions);
        assert_eq!(cap.permissions.len(), 4, "{perms}");
        for p in PERMISSIONS {
            assert!(perms.contains(p), "{p} in {perms}");
        }
        for never in [
            "fs:",
            "shell:",
            "opener:",
            "updater:",
            "dialog:",
            "core:",
            "mac-fetch",
        ] {
            assert!(!perms.contains(never), "{never} in {perms}");
        }
    }

    #[test]
    fn the_four_commands_are_registered_and_have_their_permission_files() {
        let build = include_str!("../../build.rs");
        let files = [
            (
                "cr_connect_listen",
                include_str!("../../permissions/autogenerated/cr_connect_listen.toml"),
            ),
            (
                "cr_connect_open",
                include_str!("../../permissions/autogenerated/cr_connect_open.toml"),
            ),
            (
                "cr_connect_result",
                include_str!("../../permissions/autogenerated/cr_connect_result.toml"),
            ),
            (
                "cr_connect_cancel",
                include_str!("../../permissions/autogenerated/cr_connect_cancel.toml"),
            ),
        ];
        for ((command, file), permission) in files.iter().zip(PERMISSIONS) {
            assert!(
                build.contains(&format!("\"{command}\"")),
                "{command} in build.rs"
            );
            assert!(
                file.contains(&format!("identifier = \"{permission}\"")),
                "{permission}"
            );
            assert!(
                file.contains(&format!("commands.allow = [\"{command}\"]")),
                "{command}"
            );
        }
        // The page's own capability file still grants nothing.
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
        assert_eq!(main["permissions"], serde_json::json!([]));
    }

    #[test]
    fn times_are_iso_utc() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso(UNIX_EPOCH + Duration::from_millis(1_795_264_496_789)),
            "2026-11-21T12:34:56.789Z"
        );
        assert_eq!(
            iso(UNIX_EPOCH + Duration::from_secs(951_868_799)),
            "2000-02-29T23:59:59.000Z"
        );
        assert_eq!(
            iso(UNIX_EPOCH + Duration::from_secs(4_107_542_400)),
            "2100-03-01T00:00:00.000Z"
        );
    }
}
