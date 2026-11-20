//! Getting the video on this computer (docs/CONTRACTS.md §35.5): one `yt-dlp -J` for the details and sizes, the
//! largest rung of 1080p → 720p → 480p that leaves 3 GB free, then the download itself, resumable, into the job's own
//! folder. yt-dlp runs in its own process group, so a cancel stops it and the ffmpeg it started together.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

use super::check::{self, ToolPaths};

/// The ladder, best first (§29.4 uses the same rungs in the cloud).
pub const RUNGS: [u32; 3] = [1080, 720, 480];
/// Left free on the disk after the download, like the cloud's `DISK_RESERVE`.
pub const RESERVE: u64 = 3 * 1024 * 1024 * 1024;
/// Bit rates used when YouTube gives no size for a rendition (video + audio), per rung, in bits per second.
const FALLBACK_BPS: [(u32, u64); 3] = [(1080, 5_000_000), (720, 2_500_000), (480, 1_200_000)];
const AUDIO_BPS: u64 = 130_000;
const GB: u64 = 1024 * 1024 * 1024;

/// Why getting the video stopped, as a short code the page turns into plain words (web/src/lib/macFetch.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// YouTube refused this computer too (the bot check).
    Blocked,
    /// Private, removed or members-only.
    Gone,
    /// Still live or not started yet.
    Live,
    /// Not enough room even at 480p; carries the GB to free.
    Full(u32),
    /// The tools could not be installed or checked.
    Tools,
    Canceled,
    Failed,
}

impl Failure {
    pub fn code(self) -> &'static str {
        match self {
            Failure::Blocked => "blocked",
            Failure::Gone => "gone",
            Failure::Live => "live",
            Failure::Full(_) => "full",
            Failure::Tools => "tools",
            Failure::Canceled => "canceled",
            Failure::Failed => "failed",
        }
    }
}

/// What the page passes on to the job: the video's own details, never a path or yt-dlp's text.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Details {
    pub title: Option<String>,
    pub creator: Option<String>,
    pub duration_sec: Option<f64>,
}

/// One line of plain text, at most `max` characters (titles and channel names go to the job as data).
fn clean(value: Option<&Value>, max: usize) -> Option<String> {
    let text: String = value?
        .as_str()?
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect();
    let text = text.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

pub fn details(info: &Value) -> Details {
    Details {
        title: clean(info.get("title"), 200),
        creator: clean(info.get("channel").or_else(|| info.get("uploader")), 120),
        duration_sec: info
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|d| *d > 0.0),
    }
}

/// Still live or not started: refused in plain words, before anything is downloaded.
pub fn is_live(info: &Value) -> bool {
    info.get("is_live").and_then(Value::as_bool) == Some(true)
        || matches!(
            info.get("live_status").and_then(Value::as_str),
            Some("is_live" | "is_upcoming" | "post_live")
        )
}

fn size_of(f: &Value, duration: f64) -> Option<u64> {
    let exact = f.get("filesize").and_then(Value::as_u64);
    let approx = f.get("filesize_approx").and_then(Value::as_u64);
    exact.or(approx).or_else(|| {
        let tbr = f.get("tbr").and_then(Value::as_f64)?;
        (duration > 0.0).then(|| (tbr * 1000.0 / 8.0 * duration) as u64)
    })
}

/// The bytes one rung would take (video + audio), as the format selector would choose it: the best H.264 rendition
/// at most `height` high if there is one, else any; an unknown size counts at the rung's fallback rate.
pub fn estimate(info: &Value, height: u32) -> u64 {
    let duration = info.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
    let fallback = FALLBACK_BPS
        .iter()
        .find(|(h, _)| *h == height)
        .map_or(5_000_000, |(_, b)| *b);
    let formats: Vec<&Value> = info
        .get("formats")
        .and_then(Value::as_array)
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    let video_only = |f: &&Value| {
        f.get("vcodec")
            .and_then(Value::as_str)
            .is_some_and(|c| c != "none")
            && f.get("acodec").and_then(Value::as_str) == Some("none")
            && f.get("height")
                .and_then(Value::as_u64)
                .is_some_and(|h| h <= u64::from(height))
    };
    fn best(list: Vec<&Value>) -> Option<&Value> {
        list.into_iter().max_by_key(|f| {
            (
                f.get("height").and_then(Value::as_u64).unwrap_or(0),
                f.get("tbr").and_then(Value::as_f64).unwrap_or(0.0) as u64,
            )
        })
    }
    let avc: Vec<&Value> = formats
        .iter()
        .copied()
        .filter(video_only)
        .filter(|f| {
            f.get("vcodec")
                .and_then(Value::as_str)
                .is_some_and(|c| c.starts_with("avc1"))
        })
        .collect();
    let video = best(avc).or_else(|| best(formats.iter().copied().filter(video_only).collect()));
    let audio = formats
        .iter()
        .copied()
        .filter(|f| {
            f.get("vcodec").and_then(Value::as_str) == Some("none")
                && f.get("acodec")
                    .and_then(Value::as_str)
                    .is_some_and(|c| c != "none")
        })
        .max_by_key(|f| f.get("abr").and_then(Value::as_f64).unwrap_or(0.0) as u64);
    let video_bytes = video
        .and_then(|f| size_of(f, duration))
        .unwrap_or((fallback as f64 / 8.0 * duration) as u64);
    let audio_bytes = audio
        .and_then(|f| size_of(f, duration))
        .unwrap_or((AUDIO_BPS as f64 / 8.0 * duration) as u64);
    video_bytes + audio_bytes
}

/// The first rung whose room leaves `RESERVE` free; else how many GB to free (at least 1). yt-dlp downloads the
/// video and the sound as two files and then merges them into a third, so the peak is about twice the estimate
/// (plus 10%); the returned number is the estimate the progress bar counts against.
pub fn choose(info: &Value, free: u64) -> Result<(u32, u64), Failure> {
    for h in RUNGS {
        let need = estimate(info, h) + estimate(info, h) / 10;
        if need * 2 + RESERVE <= free {
            return Ok((h, need));
        }
    }
    let lowest = estimate(info, 480);
    let need = (lowest + lowest / 10) * 2 + RESERVE;
    Err(Failure::Full(
        (need.saturating_sub(free).div_ceil(GB)).max(1) as u32,
    ))
}

/// yt-dlp's last words turned into a code. They stay on this computer (never sent anywhere).
pub fn explain(stderr_tail: &str) -> Failure {
    let t = stderr_tail.to_ascii_lowercase();
    if t.contains("sign in to confirm") || t.contains("not a bot") {
        Failure::Blocked
    } else if t.contains("is live")
        || t.contains("live event will begin")
        || t.contains("premieres in")
    {
        Failure::Live
    } else if t.contains("private video")
        || t.contains("members-only")
        || t.contains("video unavailable")
        || t.contains("has been removed")
        || t.contains("does not exist")
    {
        Failure::Gone
    } else if t.contains("no space left") {
        Failure::Full(1)
    } else {
        Failure::Failed
    }
}

/// One progress line (`CFP <done> <total> <estimate> <format>`): the format and its bytes so far.
pub fn parse_progress(line: &str) -> Option<(String, u64, Option<u64>)> {
    let rest = line.trim().strip_prefix(check::PROGRESS_PREFIX)?;
    let mut parts = rest.split_whitespace();
    let done = parts.next()?.parse::<f64>().ok()? as u64;
    let total = parts
        .next()
        .and_then(|t| t.parse::<f64>().ok())
        .map(|t| t as u64);
    let estimate = parts
        .next()
        .and_then(|t| t.parse::<f64>().ok())
        .map(|t| t as u64);
    let format = parts.next().unwrap_or("?").to_owned();
    Some((format, done, total.or(estimate)))
}

/// The running yt-dlp, so a cancel can stop its whole process group.
#[derive(Default)]
pub struct Running(Mutex<Option<u32>>);

impl Running {
    /// The process has ended: nothing is left to stop.
    pub fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn stop(&self) {
        if let Some(pid) = *self.0.lock().unwrap_or_else(|e| e.into_inner()) {
            kill_tree(pid);
        }
    }
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    let group = Pid::from_raw(pid as i32);
    let _ = killpg(group, Signal::SIGTERM);
    std::thread::sleep(Duration::from_secs(2));
    let _ = killpg(group, Signal::SIGKILL);
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
fn kill_tree(_pid: u32) {}

fn command(program: &Path, args: &[OsString]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("DENO_NO_UPDATE_CHECK", "1")
        .env("DENO_NO_PROMPT", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn spawn(program: &Path, args: &[OsString], running: &Running) -> std::io::Result<Child> {
    let child = command(program, args).spawn()?;
    *running.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child.id());
    Ok(child)
}

/// The last few KB of stderr, read on its own thread so a chatty yt-dlp never blocks on a full pipe.
fn tail_of(stderr: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            tail.push_str(&line);
            tail.push('\n');
            if tail.len() > 16 * 1024 {
                tail.drain(..tail.len() - 8 * 1024);
            }
        }
        tail
    })
}

/// `yt-dlp -J`: the video's details. A failure is explained from yt-dlp's last words.
pub fn probe(
    tools: &ToolPaths,
    id: &str,
    running: &Running,
    cancel: &AtomicBool,
) -> Result<Value, Failure> {
    let mut child =
        spawn(&tools.yt_dlp, &check::probe_args(tools, id), running).map_err(|_| Failure::Tools)?;
    let stderr = tail_of(child.stderr.take().ok_or(Failure::Failed)?);
    let mut out = Vec::new();
    child
        .stdout
        .take()
        .ok_or(Failure::Failed)?
        .take(256 * 1024 * 1024)
        .read_to_end(&mut out)
        .map_err(|_| Failure::Failed)?;
    let status = child.wait();
    // The process is gone: forget its id, so a later cancel never signals a group that now belongs to someone else.
    running.clear();
    let status = status.map_err(|_| Failure::Failed)?;
    let tail = stderr.join().unwrap_or_default();
    if cancel.load(Ordering::SeqCst) {
        return Err(Failure::Canceled);
    }
    if !status.success() {
        return Err(explain(&tail));
    }
    serde_json::from_slice(&out).map_err(|_| Failure::Failed)
}

/// Downloads rung `height` into `dir` as `video.mp4`, reporting bytes so far through `on_bytes`. Resumes from the
/// `.part` files of an earlier try.
pub fn download(
    tools: &ToolPaths,
    dir: &Path,
    height: u32,
    id: &str,
    running: &Running,
    cancel: &AtomicBool,
    mut on_bytes: impl FnMut(u64),
) -> Result<PathBuf, Failure> {
    let mut child = spawn(
        &tools.yt_dlp,
        &check::download_args(tools, dir, height, id),
        running,
    )
    .map_err(|_| Failure::Tools)?;
    let stderr = tail_of(child.stderr.take().ok_or(Failure::Failed)?);
    let mut done = std::collections::BTreeMap::<String, u64>::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some((format, bytes, _total)) = parse_progress(&line) {
                done.insert(format, bytes);
                on_bytes(done.values().sum());
            }
        }
    }
    let status = child.wait().map_err(|_| Failure::Failed)?;
    running.clear();
    let tail = stderr.join().unwrap_or_default();
    if cancel.load(Ordering::SeqCst) {
        return Err(Failure::Canceled);
    }
    if !status.success() {
        return Err(explain(&tail));
    }
    let video = dir.join("video.mp4");
    if video.metadata().is_ok_and(|m| m.len() > 0) {
        Ok(video)
    } else {
        Err(Failure::Failed)
    }
}

/// Free bytes on the disk that holds `dir`.
pub fn free_space(dir: &Path) -> u64 {
    fs4::available_space(dir).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(duration: f64, video_size: Option<u64>) -> Value {
        let mut v1080 = json!({"format_id": "137", "vcodec": "avc1.640028", "acodec": "none", "height": 1080, "tbr": 4000.0});
        let mut v720 = json!({"format_id": "136", "vcodec": "avc1.4d401f", "acodec": "none", "height": 720, "tbr": 2000.0});
        let mut v480 = json!({"format_id": "135", "vcodec": "avc1.4d401e", "acodec": "none", "height": 480, "tbr": 1000.0});
        if let Some(s) = video_size {
            v1080["filesize"] = json!(s);
            v720["filesize"] = json!(s / 2);
            v480["filesize"] = json!(s / 4);
        }
        json!({
            "title": "A\u{0007} long stream\n", "channel": "Some Streamer", "duration": duration, "live_status": "was_live",
            "formats": [
                {"format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "abr": 129.0, "filesize": 10_000_000u64},
                {"format_id": "248", "vcodec": "vp9", "acodec": "none", "height": 1080, "tbr": 9000.0},
                v1080, v720, v480,
            ]
        })
    }

    #[test]
    fn the_estimate_follows_the_h264_rendition_and_the_audio() {
        let i = info(3600.0, Some(2_000_000_000));
        assert_eq!(estimate(&i, 1080), 2_010_000_000);
        assert_eq!(estimate(&i, 720), 1_010_000_000);
        // No sizes: the rendition's own bit rate times the length.
        let j = info(3600.0, None);
        assert_eq!(estimate(&j, 1080), 4000 * 1000 / 8 * 3600 + 10_000_000);
    }

    #[test]
    fn the_rung_drops_until_it_fits_and_then_says_how_much_to_free() {
        let i = info(3600.0, Some(20 * GB));
        let roomy = 200 * GB;
        assert_eq!(choose(&i, roomy).unwrap().0, 1080);
        // The merge writes a second copy, so the room is twice the estimate plus 3 GB: 1080p about 44 + 3 GB,
        // 720p about 22 + 3 GB, 480p about 11 + 3 GB.
        assert_eq!(choose(&i, 48 * GB).unwrap().0, 1080);
        assert_eq!(
            choose(&i, 30 * GB).unwrap().0,
            720,
            "the video alone would fit 1080p, the merge would not"
        );
        assert_eq!(choose(&i, 16 * GB).unwrap().0, 480);
        match choose(&i, 4 * GB) {
            Err(Failure::Full(gb)) => assert!((10..=11).contains(&gb), "{gb}"), // about 14 GB room, 4 GB free
            other => panic!("{other:?}"),
        }
        assert!(matches!(choose(&i, 0), Err(Failure::Full(_))));
    }

    #[test]
    fn the_details_are_plain_one_line_text() {
        let d = details(&info(61.5, None));
        assert_eq!(d.title.as_deref(), Some("A long stream"));
        assert_eq!(d.creator.as_deref(), Some("Some Streamer"));
        assert_eq!(d.duration_sec, Some(61.5));
        assert_eq!(details(&json!({})), Details::default());
        let long = json!({"title": "x".repeat(500)});
        assert_eq!(details(&long).title.unwrap().len(), 200);
    }

    #[test]
    fn a_live_stream_is_refused() {
        assert!(is_live(&json!({"is_live": true})));
        assert!(is_live(&json!({"live_status": "is_upcoming"})));
        assert!(!is_live(&json!({"live_status": "was_live"})));
        assert!(!is_live(&json!({})));
    }

    #[test]
    fn yt_dlp_errors_become_codes() {
        assert_eq!(
            explain("ERROR: [youtube] x: Sign in to confirm you're not a bot"),
            Failure::Blocked
        );
        assert_eq!(
            explain("ERROR: [youtube] x: Private video. Sign in if..."),
            Failure::Gone
        );
        assert_eq!(
            explain("ERROR: [youtube] x: Video unavailable"),
            Failure::Gone
        );
        assert_eq!(
            explain("ERROR: This live event will begin in 3 hours"),
            Failure::Live
        );
        assert_eq!(
            explain("ERROR: unable to write data: [Errno 28] No space left on device"),
            Failure::Full(1)
        );
        assert_eq!(explain("ERROR: HTTP Error 500"), Failure::Failed);
        assert_eq!(Failure::Full(3).code(), "full");
    }

    #[test]
    fn progress_lines_are_read_and_others_ignored() {
        assert_eq!(
            parse_progress("CFP 1048576 2097152 NA 137"),
            Some(("137".into(), 1_048_576, Some(2_097_152)))
        );
        assert_eq!(
            parse_progress("CFP 10 NA 2000.5 140"),
            Some(("140".into(), 10, Some(2000)))
        );
        assert_eq!(parse_progress("[download] 34.2% of ~1.20GiB"), None);
        assert_eq!(parse_progress("CFP NA NA NA 1"), None);
    }

    #[test]
    fn a_finished_process_is_forgotten_so_a_cancel_signals_nothing() {
        let running = Running::default();
        *running.0.lock().unwrap() = Some(4_000_000);
        running.clear();
        assert!(running.0.lock().unwrap().is_none());
        running.stop(); // returns at once: no group to signal
    }

    #[cfg(unix)]
    #[test]
    fn a_cancel_stops_the_whole_process_group() {
        let running = Running::default();
        let script = std::env::temp_dir().join(format!("cf-sleep-{}.sh", std::process::id()));
        std::fs::write(&script, "#!/bin/sh\nsleep 30 &\nsleep 30\n").unwrap();
        let args: Vec<OsString> = vec![script.clone().into_os_string()];
        let mut child = spawn(Path::new("/bin/sh"), &args, &running).unwrap();
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(300));
        let started = std::time::Instant::now();
        running.stop();
        child.wait().unwrap();
        assert!(started.elapsed() < Duration::from_secs(10));
        // The background sleep was in the same group: nothing of the group is left.
        let left = Command::new("pgrep")
            .args(["-g", &pid.to_string()])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&left.stdout).trim().is_empty(),
            "group left running"
        );
        let _ = std::fs::remove_file(script);
    }
}
