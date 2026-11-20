//! Mac fetches it (docs/CONTRACTS.md §35, ADR-59). When YouTube blocks the cloud, this computer, on its home
//! connection, gets the video and sends it to the job. The page (web/src/lib/macFetch.ts) drives it with four
//! commands, granted only to the app's own address in the main window (`capability`):
//!
//! * `mac_fetch_start {jobId, url}`: checks both, installs or checks the pinned tools (tools.rs), reads the video's
//!   details, picks the best rung that fits the disk and downloads it, in the background. At most `MAX_AT_ONCE` jobs
//!   at a time, one fetch per job.
//! * `mac_fetch_status {jobId}`: where it is (`Status`), polled by the page about once a second.
//! * `mac_fetch_upload {jobId, partSize, parts}`: sends the downloaded file to the signed part addresses (upload.rs).
//! * `mac_fetch_cancel {jobId}`: stops the job's fetch or send, removes its folder and forgets it.
//!
//! No cookies are read, stored or sent. yt-dlp's own text never leaves this computer: the page only gets codes.

pub mod check;
pub mod download;
pub mod tools;
pub mod upload;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Url};

use download::Failure;

/// The media bucket's regional host, baked in by build.rs (empty in a debug build without it: nothing is sent).
pub const MEDIA_HOST: &str = env!("CF_MEDIA_HOST_RESOLVED");
/// The most fetches at once (each may download gigabytes).
pub const MAX_AT_ONCE: usize = 2;
/// The commands the page may call, as the capability names them.
pub const PERMISSIONS: [&str; 4] = [
    "allow-mac-fetch-start",
    "allow-mac-fetch-status",
    "allow-mac-fetch-upload",
    "allow-mac-fetch-cancel",
];

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// Installing or checking the tools.
    Tools,
    /// Downloading the video.
    Getting,
    /// Downloaded, waiting for the part addresses.
    Ready,
    /// Sending the parts.
    Sending,
    /// Every part is sent; `etags` holds what the API needs.
    Sent,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    /// 0-100 within the phase.
    pub pct: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    /// A code (download::Failure::code), never yt-dlp's text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<&'static str>,
    /// With `error: "full"`: how many GB to free.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub need_gb: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub etags: Option<Vec<upload::PartTag>>,
}

impl Status {
    fn new(phase: Phase) -> Status {
        Status {
            phase,
            pct: 0,
            size: None,
            height: None,
            title: None,
            creator: None,
            duration_sec: None,
            error: None,
            need_gb: None,
            etags: None,
        }
    }
}

struct Fetch {
    status: Mutex<Status>,
    cancel: AtomicBool,
    running: download::Running,
    /// A thread is working on this fetch (download or send).
    busy: AtomicBool,
}

impl Fetch {
    fn set(&self, f: impl FnOnce(&mut Status)) {
        f(&mut self.status.lock().unwrap_or_else(|e| e.into_inner()));
    }
    fn get(&self) -> Status {
        self.status
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// Every fetch of this app, by job id.
pub struct Fetches {
    jobs: Mutex<HashMap<String, Arc<Fetch>>>,
}

impl Default for Fetches {
    fn default() -> Self {
        Fetches {
            jobs: Mutex::new(HashMap::new()),
        }
    }
}

/// Where the tools and the jobs' folders live: `<app data>/tools` and `<app data>/fetch/<jobId>/`.
fn folders(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| "no_folder".to_owned())?;
    Ok((base.join("tools"), base.join("fetch")))
}

fn job_dir(fetch_root: &Path, job_id: &str) -> PathBuf {
    fetch_root.join(job_id)
}

/// A job's folder this old is left from a run that never finished (a job stopped or deleted while the app was closed,
/// an app that quit mid-download). A job waits at most 24 hours for its video, so nothing live is this old.
pub const LEFTOVER: std::time::Duration = std::time::Duration::from_secs(3 * 24 * 3600);

/// Removes the job folders under `root` that nothing has touched for `max_age`. Returns how many went. Only folders
/// named like a job id are looked at.
pub fn sweep_old(root: &Path, now: std::time::SystemTime, max_age: std::time::Duration) -> usize {
    let Ok(entries) = fs::read_dir(root) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_str().is_some_and(check::job_id_ok) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age >= max_age);
        if old && fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// At start-up: clears the leftovers (in the background, so the window is not kept waiting).
pub fn sweep(app: &AppHandle) {
    let Ok((_, fetch_root)) = folders(app) else {
        return;
    };
    std::thread::spawn(move || {
        sweep_old(&fetch_root, std::time::SystemTime::now(), LEFTOVER);
    });
}

#[tauri::command]
pub fn mac_fetch_start(
    app: AppHandle,
    state: State<'_, Fetches>,
    job_id: String,
    url: String,
) -> Result<Status, String> {
    if !check::job_id_ok(&job_id) {
        return Err("bad_job".into());
    }
    let id = check::video_id(&url).ok_or("bad_link")?;
    let (tools_dir, fetch_root) = folders(&app)?;
    let fetch = {
        let mut jobs = state.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = jobs.get(&job_id) {
            let s = existing.get();
            // One fetch per job: a second start reports the first; a failed one may start again.
            if s.phase != Phase::Failed || existing.busy.load(Ordering::SeqCst) {
                return Ok(s);
            }
        }
        let active = jobs
            .values()
            .filter(|f| {
                f.busy.load(Ordering::SeqCst)
                    || matches!(f.get().phase, Phase::Tools | Phase::Getting)
            })
            .count();
        if active >= MAX_AT_ONCE {
            return Err("busy".into());
        }
        let fetch = Arc::new(Fetch {
            status: Mutex::new(Status::new(Phase::Tools)),
            cancel: AtomicBool::new(false),
            running: download::Running::default(),
            busy: AtomicBool::new(true),
        });
        jobs.insert(job_id.clone(), fetch.clone());
        fetch
    };
    let dir = job_dir(&fetch_root, &job_id);
    let worker = fetch.clone();
    std::thread::Builder::new()
        .name(format!("mac-fetch-{job_id}"))
        .spawn(move || {
            let result = tools::Http::new()
                .map_err(|_| Failure::Tools)
                .and_then(|source| get_video(&worker, &source, &tools_dir, &dir, &id));
            if let Err(failure) = result {
                if failure != Failure::Canceled {
                    eprintln!("mac fetch: stopped ({})", failure.code());
                }
                worker.set(|s| {
                    s.phase = Phase::Failed;
                    s.error = Some(failure.code());
                    if let Failure::Full(gb) = failure {
                        s.need_gb = Some(gb);
                    }
                });
            }
            worker.busy.store(false, Ordering::SeqCst);
        })
        .map_err(|_| "no_thread".to_owned())?;
    Ok(fetch.get())
}

fn get_video(
    fetch: &Fetch,
    source: &dyn tools::Source,
    tools_dir: &Path,
    dir: &Path,
    id: &str,
) -> Result<(), Failure> {
    let tools = tools::ensure(tools_dir, source, tools::PUBLIC_KEY).map_err(|e| {
        eprintln!("mac fetch: {e}");
        Failure::Tools
    })?;
    if fetch.cancel.load(Ordering::SeqCst) {
        return Err(Failure::Canceled);
    }
    fs::create_dir_all(dir).map_err(|_| Failure::Failed)?;
    fetch.set(|s| s.phase = Phase::Getting);
    let info = download::probe(&tools, id, &fetch.running, &fetch.cancel)?;
    if download::is_live(&info) {
        return Err(Failure::Live);
    }
    let details = download::details(&info);
    let (height, estimate) = download::choose(&info, download::free_space(dir))?;
    fetch.set(|s| {
        s.title = details.title.clone();
        s.creator = details.creator.clone();
        s.duration_sec = details.duration_sec;
        s.height = Some(height);
    });
    let video = download::download(
        &tools,
        dir,
        height,
        id,
        &fetch.running,
        &fetch.cancel,
        |bytes| {
            let pct = (bytes.saturating_mul(100) / estimate.max(1)).min(99) as u8;
            fetch.set(|s| s.pct = s.pct.max(pct));
        },
    )?;
    let size = fs::metadata(&video).map_err(|_| Failure::Failed)?.len();
    fetch.set(|s| {
        s.phase = Phase::Ready;
        s.pct = 100;
        s.size = Some(size);
    });
    Ok(())
}

#[tauri::command]
pub fn mac_fetch_status(
    state: State<'_, Fetches>,
    job_id: String,
) -> Result<Option<Status>, String> {
    if !check::job_id_ok(&job_id) {
        return Err("bad_job".into());
    }
    let jobs = state.jobs.lock().unwrap_or_else(|e| e.into_inner());
    Ok(jobs.get(&job_id).map(|f| f.get()))
}

#[tauri::command]
pub fn mac_fetch_upload(
    app: AppHandle,
    state: State<'_, Fetches>,
    job_id: String,
    part_size: u64,
    parts: Vec<upload::PartUrl>,
) -> Result<Status, String> {
    if !check::job_id_ok(&job_id) {
        return Err("bad_job".into());
    }
    let (_, fetch_root) = folders(&app)?;
    let fetch = state
        .jobs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&job_id)
        .cloned()
        .ok_or("unknown_job")?;
    let s = fetch.get();
    if matches!(s.phase, Phase::Sending | Phase::Sent) {
        return Ok(s);
    }
    if s.phase != Phase::Ready && !(s.phase == Phase::Failed && s.size.is_some()) {
        return Err("not_ready".into());
    }
    let dir = job_dir(&fetch_root, &job_id);
    let video = dir.join("video.mp4");
    let size = fs::metadata(&video)
        .map_err(|_| "not_ready".to_owned())?
        .len();
    upload::check_parts(&parts, size, part_size, MEDIA_HOST).map_err(|_| "bad_parts".to_owned())?;
    if fetch.busy.swap(true, Ordering::SeqCst) {
        return Ok(fetch.get());
    }
    fetch.set(|s| {
        s.phase = Phase::Sending;
        s.pct = 0;
        s.error = None;
    });
    let worker = fetch.clone();
    std::thread::Builder::new()
        .name(format!("mac-send-{job_id}"))
        .spawn(move || {
            let result = upload::HttpPut::new()
                .map_err(upload::UploadError::Failed)
                .and_then(|put| {
                    upload::send(
                        &video,
                        &parts,
                        part_size,
                        MEDIA_HOST,
                        &dir.join("parts.json"),
                        &put,
                        &worker.cancel,
                        |sent| {
                            let pct = (sent.saturating_mul(100) / size.max(1)).min(100) as u8;
                            worker.set(|s| s.pct = pct);
                        },
                    )
                });
            match result {
                Ok(tags) => worker.set(|s| {
                    s.phase = Phase::Sent;
                    s.pct = 100;
                    s.etags = Some(tags);
                }),
                Err(e) => {
                    if e != upload::UploadError::Canceled {
                        eprintln!("mac fetch: send stopped");
                    }
                    worker.set(|s| {
                        s.phase = Phase::Failed;
                        s.error = Some(if e == upload::UploadError::Canceled {
                            "canceled"
                        } else {
                            "send"
                        });
                    });
                }
            }
            worker.busy.store(false, Ordering::SeqCst);
        })
        .map_err(|_| "no_thread".to_owned())?;
    Ok(fetch.get())
}

#[tauri::command]
pub fn mac_fetch_cancel(
    app: AppHandle,
    state: State<'_, Fetches>,
    job_id: String,
) -> Result<bool, String> {
    if !check::job_id_ok(&job_id) {
        return Err("bad_job".into());
    }
    let (_, fetch_root) = folders(&app)?;
    let fetch = state
        .jobs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&job_id);
    let dir = job_dir(&fetch_root, &job_id);
    let known = fetch.is_some();
    std::thread::spawn(move || {
        if let Some(f) = &fetch {
            f.cancel.store(true, Ordering::SeqCst);
            f.running.stop();
            // Wait for the worker to let go of the folder before it is removed.
            for _ in 0..100 {
                if !f.busy.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        let _ = fs::remove_dir_all(&dir);
    });
    Ok(known)
}

/// The page's only other grant (beside the title-bar drag): these four commands, for the app's own address, in the
/// main window, never a local page.
pub fn capability(app_url: &Url, window: &str) -> tauri::ipc::CapabilityBuilder {
    let mut cap = tauri::ipc::CapabilityBuilder::new("mac-fetch")
        .remote(format!("{}/*", app_url.origin().ascii_serialization()))
        .local(false)
        .window(window);
    for p in PERMISSIONS {
        cap = cap.permission(p);
    }
    cap
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_app_itself_may_fetch_and_only_these_commands() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        let CapabilityFile::Capability(cap) =
            capability(&Url::parse("https://d1.cloudfront.net/").unwrap(), "main").build()
        else {
            panic!("one capability");
        };
        assert_eq!(cap.identifier, "mac-fetch");
        assert!(!cap.local);
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
        for never in ["fs:", "shell:", "opener:", "updater:", "dialog:", "core:"] {
            assert!(!perms.contains(never), "{never} in {perms}");
        }
    }

    /// The tools as CI publishes them, from a folder on this computer: `tools.json` and `tools.json.sig` at its top
    /// and the files under `files/<tool>/<version>/<platform>/<name>` (desktop/tools/build_tools.py fetch).
    struct Folder(PathBuf);

    impl tools::Source for Folder {
        fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
            let mut out = Vec::new();
            self.get_to(url, &mut out, max)?;
            Ok(out)
        }
        fn get_to(&self, url: &str, to: &mut dyn std::io::Write, max: u64) -> Result<u64, String> {
            let rest = url
                .strip_prefix(&format!("https://{}/downloads/tools/", tools::TOOLS_HOST))
                .ok_or("not the tools host")?;
            let path = if rest.starts_with("tools.json") {
                self.0.join(rest)
            } else {
                self.0.join("files").join(rest)
            };
            let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
            let n = std::io::copy(&mut std::io::Read::take(&mut f, max + 1), to)
                .map_err(|e| e.to_string())?;
            if n > max {
                return Err("too large".into());
            }
            Ok(n)
        }
    }

    /// The real thing on this computer's own connection: the signed tools (checked with the app's built-in key),
    /// then a short public YouTube video, exactly as `mac_fetch_start` does it. Needs the network and a folder made
    /// by `build_tools.py fetch` and signed with the real key, so it only runs when asked:
    /// `CF_PROOF_TOOLS=<folder> cargo test real_download -- --ignored --nocapture`.
    #[test]
    #[ignore = "network: downloads a real YouTube video"]
    fn real_download_of_a_short_public_video() {
        let folder = PathBuf::from(std::env::var("CF_PROOF_TOOLS").expect("CF_PROOF_TOOLS"));
        let work = std::env::temp_dir().join(format!("cf-proof-{}", std::process::id()));
        let _ = fs::remove_dir_all(&work);
        let fetch = Fetch {
            status: Mutex::new(Status::new(Phase::Tools)),
            cancel: AtomicBool::new(false),
            running: download::Running::default(),
            busy: AtomicBool::new(true),
        };
        let id = check::video_id("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLx").unwrap();
        let dir = work.join("fetch").join("01JABCDEFGHJKMNPQRSTVWXYZ0");
        let started = std::time::Instant::now();
        get_video(&fetch, &Folder(folder), &work.join("tools"), &dir, &id).expect("downloaded");
        let s = fetch.get();
        let video = dir.join("video.mp4");
        let size = fs::metadata(&video).unwrap().len();
        println!(
            "phase={:?} height={:?} size={size} title={:?} creator={:?} duration={:?} seconds={:.1}",
            s.phase,
            s.height,
            s.title,
            s.creator,
            s.duration_sec,
            started.elapsed().as_secs_f64()
        );
        assert_eq!(s.phase, Phase::Ready);
        assert_eq!(s.size, Some(size));
        let head = fs::read(&video).unwrap();
        assert_eq!(&head[4..8], b"ftyp", "an mp4 file");
        let ffprobe = work.join("tools").join("ffmpeg");
        println!("tools in {}", ffprobe.display());
        if std::env::var("CF_PROOF_KEEP").is_err() {
            fs::remove_dir_all(&work).unwrap();
            assert!(!video.exists());
            println!("deleted {}", work.display());
        }
    }

    #[test]
    fn old_job_folders_are_swept_and_young_ones_and_strangers_are_kept() {
        let root = std::env::temp_dir().join(format!("cf-sweep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let old = root.join("01JABCDEFGHJKMNPQRSTVWXYZ0");
        let young = root.join("01JABCDEFGHJKMNPQRSTVWXYZ1");
        let stranger = root.join("keep-me");
        for d in [&old, &young, &stranger] {
            fs::create_dir_all(d).unwrap();
            fs::write(d.join("video.mp4"), b"x").unwrap();
        }
        // "Now" is a week on: every folder is a week old, so only the 3-day rule decides, and the stranger is not
        // named like a job.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(7 * 24 * 3600);
        assert_eq!(sweep_old(&root, later, LEFTOVER), 2);
        assert!(!old.exists() && !young.exists());
        assert!(stranger.exists());
        // Nothing is older than a day yet.
        fs::create_dir_all(&young).unwrap();
        assert_eq!(sweep_old(&root, std::time::SystemTime::now(), LEFTOVER), 0);
        assert!(young.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_page_reads_codes_never_yt_dlp_text() {
        let mut s = Status::new(Phase::Failed);
        s.error = Some(Failure::Full(6).code());
        s.need_gb = Some(6);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["phase"], "failed");
        assert_eq!(json["error"], "full");
        assert_eq!(json["needGb"], 6);
        assert!(json.get("etags").is_none());
    }
}
