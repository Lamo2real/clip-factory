//! What the page may hand the app, checked before anything runs (docs/CONTRACTS.md §35.6): the YouTube link (rebuilt
//! from its 11-character id), the job id, and the S3 part addresses the video is sent to. Pure functions, so every
//! rule has a unit test.

use std::ffi::OsString;
use std::path::Path;

use tauri::Url;

/// The only hosts a link may name. Anything else, including look-alikes such as `youtube.com.evil.test`, is refused.
const HOSTS: [&str; 4] = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
];
/// The most a link may be: the page sends what the owner pasted.
const MAX_LINK: usize = 2048;

/// The YouTube video id of `raw`, or None. Only `https`, only the four hosts, no user info, no port; the id must be
/// exactly 11 characters of `[A-Za-z0-9_-]`. Playlists and every other parameter are dropped by `watch_url`.
pub fn video_id(raw: &str) -> Option<String> {
    if raw.len() > MAX_LINK {
        return None;
    }
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let host = url.host_str()?;
    if !HOSTS.contains(&host) {
        return None;
    }
    let mut segments = url.path_segments()?.filter(|s| !s.is_empty());
    let first = segments.next();
    let id = if host == "youtu.be" {
        let id = first?;
        segments.next().is_none().then_some(id)?.to_owned()
    } else {
        match first? {
            "watch" if segments.next().is_none() => url
                .query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.into_owned())?,
            "shorts" | "live" | "embed" => {
                let id = segments.next()?;
                segments.next().is_none().then_some(id)?.to_owned()
            }
            _ => return None,
        }
    };
    id_ok(&id).then_some(id)
}

fn id_ok(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The one address yt-dlp is ever given: a plain watch page, nothing the page wrote.
pub fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// A job id as the API makes them: a ULID (26 characters of Crockford base32, the first 0-7).
pub fn job_id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 26
        && (b'0'..=b'7').contains(&b[0])
        && b.iter().all(|c| {
            c.is_ascii_digit()
                || (c.is_ascii_uppercase() && !matches!(c, b'I' | b'L' | b'O' | b'U'))
        })
}

/// An S3 part address the app may PUT to: https on exactly `media_host` (baked in at build time), no port or user
/// info, a key under `uploads/`, and a signed `UploadPart` query for part `n`. Returns the upload id it names.
pub fn part_url(raw: &str, media_host: &str, n: u32) -> Option<String> {
    if media_host.is_empty() || raw.len() > 4096 {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some(media_host)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with("/uploads/")
        || url.path().contains("..")
        || url.fragment().is_some()
    {
        return None;
    }
    let mut upload_id = None;
    let mut number = None;
    let mut signed = false;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "uploadId" => upload_id = Some(v.into_owned()),
            "partNumber" => number = v.parse::<u32>().ok(),
            "X-Amz-Signature" => signed = !v.is_empty(),
            _ => {}
        }
    }
    let upload_id = upload_id.filter(|u| !u.is_empty() && u.len() <= 1024)?;
    (signed && number == Some(n)).then_some(upload_id)
}

/// The tools a fetch runs, all from the verified install (tools.rs).
#[derive(Clone, Debug)]
pub struct ToolPaths {
    pub yt_dlp: std::path::PathBuf,
    pub deno: std::path::PathBuf,
    pub ffmpeg_dir: std::path::PathBuf,
}

/// The arguments every yt-dlp run starts with: no config file, no plugins, never any cookies, the pinned Deno for
/// YouTube's challenges and the pinned ffmpeg. Nothing here comes from the page.
fn base_args(tools: &ToolPaths) -> Vec<OsString> {
    let mut deno = OsString::from("deno:");
    deno.push(&tools.deno);
    vec![
        "--ignore-config".into(),
        "--no-plugin-dirs".into(),
        "--no-cookies".into(),
        "--no-cookies-from-browser".into(),
        "--no-playlist".into(),
        "--no-cache-dir".into(),
        "--js-runtimes".into(),
        deno,
        "--ffmpeg-location".into(),
        tools.ffmpeg_dir.clone().into_os_string(),
        "--retries".into(),
        "10".into(),
        "--fragment-retries".into(),
        "10".into(),
        "--socket-timeout".into(),
        "30".into(),
    ]
}

/// `yt-dlp -J`: the video's details and formats, to pick a size that fits the disk.
pub fn probe_args(tools: &ToolPaths, id: &str) -> Vec<OsString> {
    let mut args = base_args(tools);
    args.extend(["-J".into(), "--".into(), watch_url(id).into()]);
    args
}

/// The format for one rung of the ladder: H.264 first (it plays everywhere and cuts fastest), at most `height`.
pub fn format_for(height: u32) -> String {
    format!("bv*[height<={height}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<={height}]+ba/b[height<={height}]")
}

/// The progress line yt-dlp prints for every update: bytes so far, the total (or its estimate) and the format.
pub const PROGRESS_PREFIX: &str = "CFP ";
const PROGRESS_TEMPLATE: &str =
    "download:CFP %(progress.downloaded_bytes)s %(progress.total_bytes)s \
                                 %(progress.total_bytes_estimate)s %(info.format_id)s";

/// The download itself: resumable (`--continue`, `.part` files in the job's own folder), merged into `video.mp4`.
/// The link is the single positional argument, after `--`.
pub fn download_args(tools: &ToolPaths, dir: &Path, height: u32, id: &str) -> Vec<OsString> {
    let mut args = base_args(tools);
    let mut out = dir.as_os_str().to_owned();
    out.push(std::path::MAIN_SEPARATOR_STR);
    out.push("video.%(ext)s");
    args.extend([
        "-f".into(),
        format_for(height).into(),
        "--merge-output-format".into(),
        "mp4".into(),
        "--continue".into(),
        "--newline".into(),
        "--progress-template".into(),
        PROGRESS_TEMPLATE.into(),
        "--http-chunk-size".into(),
        "10M".into(),
        "-o".into(),
        out,
        "--".into(),
        watch_url(id).into(),
    ]);
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "dQw4w9WgXcQ";

    #[test]
    fn accepts_the_usual_youtube_links() {
        for ok in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?si=abc",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
            "  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ",
        ] {
            assert_eq!(video_id(ok).as_deref(), Some(ID), "{ok}");
        }
    }

    #[test]
    fn refuses_everything_else() {
        for bad in [
            "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
            "https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
            "https://user@www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://user:pw@youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
            "javascript:alert(1)//https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "file:///etc/passwd",
            "https://www.youtube.com/playlist?list=PL1234567890",
            "https://www.youtube.com/watch?list=PL1234567890",
            "https://www.youtube.com/watch?v=dQw4w9WgXc",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQQ",
            "https://www.youtube.com/watch?v=dQw4w9WgX%20Q",
            "https://www.youtube.com/watch?v=dQw4w9WgX$Q",
            "https://youtu.be/dQw4w9WgXcQ/extra",
            "https://youtu.be/",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/channel/UC1234567890",
            "https://www.youtube.com/watch/dQw4w9WgXcQ?v=dQw4w9WgXcQ",
            "",
            "not a link",
        ] {
            assert_eq!(video_id(bad), None, "{bad}");
        }
        assert_eq!(
            video_id(&format!("https://youtu.be/{ID}?{}", "a".repeat(3000))),
            None
        );
    }

    #[test]
    fn the_link_given_to_yt_dlp_is_rebuilt_from_the_id() {
        let id = video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&x=--exec").unwrap();
        assert_eq!(
            watch_url(&id),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn job_ids_are_ulids() {
        assert!(job_id_ok("01JABCDEFGHJKMNPQRSTVWXYZ0"));
        assert!(
            !job_id_ok("81JABCDEFGHJKMNPQRSTVWXYZ0"),
            "first character 0-7"
        );
        assert!(!job_id_ok("01JABCDEFGHJKMNPQRSTVWXYZ"), "26 characters");
        assert!(!job_id_ok("01jabcdefghjkmnpqrstvwxyz0"), "upper case");
        assert!(!job_id_ok("01JABCDEFGHJKMNPQRSTVWXYI0"), "no I, L, O, U");
        assert!(!job_id_ok("../../../../etc/passwd0000"));
        assert!(!job_id_ok(""));
    }

    const HOST: &str = "cf-prod-media-123.s3.eu-north-1.amazonaws.com";

    fn part(n: u32) -> String {
        format!(
            "https://{HOST}/uploads/u1/mac-01JABCDEFGHJKMNPQRSTVWXYZ0/video.mp4?uploadId=abc.def&partNumber={n}\
             &X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=f00d"
        )
    }

    #[test]
    fn part_urls_only_go_to_the_media_bucket() {
        assert_eq!(part_url(&part(3), HOST, 3).as_deref(), Some("abc.def"));
        assert_eq!(
            part_url(&part(3), HOST, 4),
            None,
            "the part number must match"
        );
        assert_eq!(
            part_url(&part(3), "", 3),
            None,
            "no host baked in: nothing is sent"
        );
        for bad in [
            part(1).replace("https://", "http://"),
            part(1).replace(HOST, "evil.test"),
            part(1).replace(HOST, &format!("{HOST}.evil.test")),
            part(1).replace(HOST, &format!("{HOST}:8443")),
            part(1).replace(HOST, &format!("me@{HOST}")),
            part(1).replace("/uploads/", "/jobs/"),
            part(1).replace("/uploads/u1/", "/uploads/../jobs/"),
            part(1).replace("&X-Amz-Signature=f00d", ""),
            part(1).replace("uploadId=abc.def&", ""),
            format!("{}#frag", part(1)),
        ] {
            assert_eq!(part_url(&bad, HOST, 1), None, "{bad}");
        }
    }

    fn tools() -> ToolPaths {
        ToolPaths {
            yt_dlp: "/t/yt-dlp".into(),
            deno: "/t/deno".into(),
            ffmpeg_dir: "/t/ffmpeg".into(),
        }
    }

    #[test]
    fn the_arguments_never_read_config_or_cookies_and_end_with_the_link() {
        let args = download_args(&tools(), Path::new("/f/job"), 720, ID);
        let text: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        for must in [
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-cookies",
            "--no-cookies-from-browser",
            "--continue",
        ] {
            assert!(text.iter().any(|a| a == must), "{must} in {text:?}");
        }
        for never in [
            "--exec",
            "--cookies",
            "--cookies-from-browser",
            "-U",
            "--update",
            "--no-part",
        ] {
            assert!(!text.iter().any(|a| a == never), "{never} in {text:?}");
        }
        assert!(text.contains(&"deno:/t/deno".to_owned()));
        let n = text.len();
        assert_eq!(text[n - 2], "--");
        assert_eq!(text[n - 1], "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert!(text.contains(&format_for(720)));
        assert!(format_for(720).contains("height<=720"));
        let probe: Vec<String> = probe_args(&tools(), ID)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            &probe[probe.len() - 3..],
            ["-J", "--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]
        );
        assert!(probe.contains(&"--no-cookies".to_owned()));
    }
}
