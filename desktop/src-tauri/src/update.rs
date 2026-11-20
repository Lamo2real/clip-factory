//! The app updates itself (docs/CONTRACTS.md §12.6, ADR-46). The web pages already update by themselves; this keeps
//! the native window (glass, link handling, the injected script) up to date too, so an old copy can never hide a
//! feature again.
//!
//! - A few seconds after the window shows, and every 6 hours while the app runs, it reads
//!   `https://dglrbjmf28m6c.cloudfront.net/downloads/latest.json` (written by deploy.yml after the bundles are
//!   uploaded). Only https, only that host, for the manifest and for the bundle it names.
//! - A newer version (never an older or equal one) is downloaded in the background and checked against the public
//!   key in tauri.conf.json (and against the version it was signed for, `requireSignedVersion`).
//! - Once it is ready, one native dialog asks: "Restart now" or "Later". Later means the next start uses it, and
//!   nothing asks again while this copy runs.
//! - Anything that goes wrong is written to stderr and otherwise ignored: no error dialog, ever.

use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// The one place updates come from. tauri.conf.json names the same address (a test keeps the two in step).
pub const MANIFEST_URL: &str = "https://dglrbjmf28m6c.cloudfront.net/downloads/latest.json";
/// The host both the manifest and the bundles must be on.
pub const UPDATE_HOST: &str = "dglrbjmf28m6c.cloudfront.net";

/// Long enough for the window and the page to settle first.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(5);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// The check plus the whole download: about 1 Mbit/s still fetches the universal Mac bundle.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub const DIALOG_TITLE: &str = "Clip Factory updated";
pub const DIALOG_MESSAGE: &str = "Restart to use the newest version.";
pub const RESTART_NOW: &str = "Restart now";
pub const LATER: &str = "Later";

/// An address updates may come from: https on our own CloudFront host, nothing else.
pub fn allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some(UPDATE_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

/// A downloaded update, waiting for the owner's answer.
enum Ready {
    /// macOS (and Linux): the new app is already in place on disk; a restart starts it.
    Installed,
    /// Windows: the installer is downloaded and verified; running it closes this copy.
    Pending(Box<(tauri_plugin_updater::Update, Vec<u8>)>),
}

/// On Windows, an installer the owner said "Later" to. It runs (quietly, without reopening the app) when the app
/// quits, so the next start is the new version.
#[derive(Default)]
pub struct LaterInstall(std::sync::Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

/// Starts the background checks. Release builds only: a debug build talks to the local dev server.
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("updater".into())
        .spawn(move || run(&app));
    if let Err(err) = spawned {
        eprintln!("update: could not start the update checks: {err}");
    }
}

fn run(app: &AppHandle) {
    thread::sleep(FIRST_CHECK_AFTER);
    loop {
        match tauri::async_runtime::block_on(prepare(app)) {
            Ok(Some(ready)) => {
                // Asked once; whatever the answer, this copy never asks again.
                ask(app, ready);
                return;
            }
            Ok(None) => {}
            Err(err) => eprintln!("update: {err}"),
        }
        thread::sleep(CHECK_EVERY);
    }
}

/// Checks for a newer version and, when there is one, downloads (and on macOS installs) it.
async fn prepare(app: &AppHandle) -> Result<Option<Ready>, String> {
    let manifest = Url::parse(MANIFEST_URL).map_err(|e| e.to_string())?;
    if !allowed(&manifest) {
        return Err(format!("refusing the manifest address {manifest}"));
    }
    let updater = app
        .updater_builder()
        .endpoints(vec![manifest])
        .map_err(|e| e.to_string())?
        // Covers the check and the whole download (reqwest's timeout runs to the end of the body), so it leaves
        // room for the universal Mac bundle on a slow connection.
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    // `check` only answers with a version newer than this one (allowDowngrades stays off).
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    if !allowed(&update.download_url) {
        return Err(format!(
            "refusing version {} from {}",
            update.version, update.download_url
        ));
    }
    // `download` verifies the signature (and the version it was signed for) before it returns the bytes.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    if cfg!(windows) {
        Ok(Some(Ready::Pending(Box::new((update, bytes)))))
    } else {
        update.install(&bytes).map_err(|e| e.to_string())?;
        Ok(Some(Ready::Installed))
    }
}

/// The one question, in plain words.
fn ask(app: &AppHandle, ready: Ready) {
    let restart = app
        .dialog()
        .message(DIALOG_MESSAGE)
        .title(DIALOG_TITLE)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            RESTART_NOW.into(),
            LATER.into(),
        ))
        .blocking_show();
    match ready {
        Ready::Installed => {
            if restart {
                app.restart();
            }
        }
        Ready::Pending(pending) => {
            let (update, bytes) = *pending;
            if restart {
                // Runs the installer (it reopens the app when done) and closes this copy.
                if let Err(err) = update.install(&bytes) {
                    eprintln!(
                        "update: could not install version {}: {err}",
                        update.version
                    );
                }
            } else if let Some(later) = app.try_state::<LaterInstall>() {
                match later.0.lock() {
                    Ok(mut slot) => *slot = Some((update, bytes)),
                    Err(err) => eprintln!("update: could not keep the update for later: {err}"),
                }
            }
        }
    }
}

/// Called when the app quits: runs an installer the owner said "Later" to, without reopening the app.
pub fn install_on_exit(app: &AppHandle) {
    let Some(later) = app.try_state::<LaterInstall>() else {
        return;
    };
    let pending = match later.0.lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => None,
    };
    if let Some((update, bytes)) = pending {
        let update = update.restart_after_install(false);
        if let Err(err) = update.install(&bytes) {
            eprintln!(
                "update: could not install version {}: {err}",
                update.version
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn updates_come_only_from_our_cloudfront_over_https() {
        assert!(allowed(&url(MANIFEST_URL)));
        assert!(allowed(&url(
            "https://dglrbjmf28m6c.cloudfront.net/downloads/updates/1.42.0/Clip-Factory.app.tar.gz"
        )));
        assert!(!allowed(&url(
            "http://dglrbjmf28m6c.cloudfront.net/downloads/latest.json"
        )));
        assert!(!allowed(&url("https://evil.example/downloads/latest.json")));
        assert!(!allowed(&url(
            "https://dglrbjmf28m6c.cloudfront.net.evil.example/latest.json"
        )));
        assert!(!allowed(&url(
            "https://dglrbjmf28m6c.cloudfront.net:8443/downloads/latest.json"
        )));
        assert!(!allowed(&url(
            "https://user@dglrbjmf28m6c.cloudfront.net/downloads/latest.json"
        )));
        assert!(!allowed(&url("file:///tmp/latest.json")));
    }

    #[test]
    fn the_config_names_the_same_manifest_and_a_key() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        assert_eq!(updater["endpoints"], serde_json::json!([MANIFEST_URL]));
        let pubkey = updater["pubkey"].as_str().unwrap_or_default();
        assert!(pubkey.len() > 40, "the updater public key is set");
        // Never an older release passed off as newer, never a downgrade, never plain http.
        assert_eq!(updater["requireSignedVersion"], serde_json::json!(true));
        assert!(updater.get("allowDowngrades").is_none_or(|v| v == false));
        assert!(updater
            .get("dangerousInsecureTransportProtocol")
            .is_none_or(|v| v == false));
        // Local builds make no update bundles (they would need the private key); CI turns them on.
        assert!(conf["bundle"].get("createUpdaterArtifacts").is_none());
    }

    #[test]
    fn the_question_is_short_and_plain() {
        assert_eq!(DIALOG_TITLE, "Clip Factory updated");
        assert_eq!(DIALOG_MESSAGE, "Restart to use the newest version.");
        assert_eq!((RESTART_NOW, LATER), ("Restart now", "Later"));
    }

    #[test]
    fn checks_start_soon_and_repeat_every_six_hours() {
        assert!(FIRST_CHECK_AFTER <= Duration::from_secs(10));
        assert_eq!(CHECK_EVERY, Duration::from_secs(21_600));
    }
}
