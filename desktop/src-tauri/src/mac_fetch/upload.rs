//! Sending the video to the job (docs/CONTRACTS.md §35.3): the page asks the API for one signed address per 64 MB
//! part of a multipart upload and hands them over; the app PUTs each part straight from the file (the page never
//! holds the video) and returns the ETags the API needs to finish the upload. Parts already sent for the same upload
//! are remembered in `parts.json` beside the video, so an interrupted send picks up where it stopped.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::check;

/// The part size the API uses (api/src/clipfactory_api/macfetch.py `PART_SIZE`). Anything else is refused.
pub const PART_SIZE: u64 = 64 * 1024 * 1024;
const TRIES: u32 = 4;

#[derive(Debug, Clone, Deserialize)]
pub struct PartUrl {
    pub n: u32,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PartTag {
    pub n: u32,
    pub etag: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UploadError {
    /// A part address is not on the media bucket, or the list does not cover the file exactly.
    Refused(&'static str),
    Canceled,
    Failed(String),
}

/// Checks the whole list before anything is sent: parts 1..=n in order, one upload id, every address on the media
/// bucket, and exactly as many parts as the file needs at `part_size`. Returns the upload id.
pub fn check_parts(
    parts: &[PartUrl],
    size: u64,
    part_size: u64,
    media_host: &str,
) -> Result<String, UploadError> {
    if part_size != PART_SIZE {
        return Err(UploadError::Refused("part size"));
    }
    let want = size.div_ceil(part_size).max(1);
    if parts.len() as u64 != want || parts.len() > 10_000 {
        return Err(UploadError::Refused("part count"));
    }
    let mut upload = None;
    for (i, p) in parts.iter().enumerate() {
        if p.n as usize != i + 1 {
            return Err(UploadError::Refused("part order"));
        }
        let id =
            check::part_url(&p.url, media_host, p.n).ok_or(UploadError::Refused("part address"))?;
        if upload.get_or_insert_with(|| id.clone()) != &id {
            return Err(UploadError::Refused("one upload"));
        }
    }
    upload.ok_or(UploadError::Refused("part count"))
}

/// Sends one part; returns its ETag.
pub trait Put {
    fn put(&self, url: &str, body: Vec<u8>) -> Result<String, String>;
}

pub struct HttpPut(reqwest::blocking::Client);

impl HttpPut {
    pub fn new() -> Result<HttpPut, String> {
        reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(20 * 60))
            .build()
            .map(HttpPut)
            .map_err(|e| e.to_string())
    }
}

impl Put for HttpPut {
    fn put(&self, url: &str, body: Vec<u8>) -> Result<String, String> {
        let r = self
            .0
            .put(url)
            .body(body)
            .send()
            .map_err(|e| e.without_url().to_string())?;
        if !r.status().is_success() {
            return Err(format!("status {}", r.status().as_u16()));
        }
        r.headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| "no ETag".to_owned())
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Record {
    upload: String,
    done: BTreeMap<u32, String>,
}

/// Sends `file` in the given parts, skipping parts already sent for this upload id; calls `on_bytes` with the bytes
/// sent so far. Returns every part's ETag, in order.
#[allow(clippy::too_many_arguments)] // each is one plain input; a struct would only rename them
pub fn send(
    file: &Path,
    parts: &[PartUrl],
    part_size: u64,
    media_host: &str,
    record: &Path,
    put: &dyn Put,
    cancel: &AtomicBool,
    mut on_bytes: impl FnMut(u64),
) -> Result<Vec<PartTag>, UploadError> {
    let size = fs::metadata(file)
        .map_err(|e| UploadError::Failed(e.to_string()))?
        .len();
    let upload = check_parts(parts, size, part_size, media_host)?;
    let mut rec: Record = fs::read(record)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|r: &Record| r.upload == upload)
        .unwrap_or(Record {
            upload,
            done: BTreeMap::new(),
        });
    let mut f = fs::File::open(file).map_err(|e| UploadError::Failed(e.to_string()))?;
    let mut sent: u64 = rec.done.keys().map(|n| part_len(*n, size, part_size)).sum();
    on_bytes(sent);
    for p in parts {
        if rec.done.contains_key(&p.n) {
            continue;
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(UploadError::Canceled);
        }
        let len = part_len(p.n, size, part_size);
        let mut body = vec![0u8; len as usize];
        f.seek(SeekFrom::Start(u64::from(p.n - 1) * part_size))
            .and_then(|_| f.read_exact(&mut body))
            .map_err(|e| UploadError::Failed(e.to_string()))?;
        let mut last = String::new();
        let mut etag = None;
        for attempt in 0..TRIES {
            if cancel.load(Ordering::SeqCst) {
                return Err(UploadError::Canceled);
            }
            match put.put(&p.url, body.clone()) {
                Ok(tag) => {
                    etag = Some(tag);
                    break;
                }
                Err(e) => {
                    last = e;
                    std::thread::sleep(Duration::from_millis(500 * 2u64.pow(attempt)));
                }
            }
        }
        let etag = etag.ok_or(UploadError::Failed(last))?;
        rec.done.insert(p.n, etag);
        let _ = fs::write(record, serde_json::to_vec(&rec).unwrap_or_default());
        sent += len;
        on_bytes(sent);
    }
    Ok(parts
        .iter()
        .map(|p| PartTag {
            n: p.n,
            etag: rec.done[&p.n].clone(),
        })
        .collect())
}

fn part_len(n: u32, size: u64, part_size: u64) -> u64 {
    let start = u64::from(n - 1) * part_size;
    size.saturating_sub(start).min(part_size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const HOST: &str = "cf-prod-media-123.s3.eu-north-1.amazonaws.com";

    fn urls(n: u32, upload: &str) -> Vec<PartUrl> {
        (1..=n)
            .map(|i| PartUrl {
                n: i,
                url: format!(
                    "https://{HOST}/uploads/u/mac-J/video.mp4?uploadId={upload}&partNumber={i}&X-Amz-Signature=s"
                ),
            })
            .collect()
    }

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<(String, usize)>>,
        fail_first: RefCell<u32>,
    }

    impl Put for Fake {
        fn put(&self, url: &str, body: Vec<u8>) -> Result<String, String> {
            if *self.fail_first.borrow() > 0 {
                *self.fail_first.borrow_mut() -= 1;
                return Err("status 503".into());
            }
            self.calls.borrow_mut().push((url.to_owned(), body.len()));
            Ok(format!("\"etag-{}\"", self.calls.borrow().len()))
        }
    }

    #[test]
    fn the_list_must_cover_the_file_on_the_media_bucket() {
        let size = PART_SIZE * 2 + 5;
        assert_eq!(
            check_parts(&urls(3, "U1"), size, PART_SIZE, HOST).unwrap(),
            "U1"
        );
        assert_eq!(
            check_parts(&urls(2, "U1"), size, PART_SIZE, HOST),
            Err(UploadError::Refused("part count"))
        );
        assert_eq!(
            check_parts(&urls(3, "U1"), size, 1024, HOST),
            Err(UploadError::Refused("part size"))
        );
        let mut mixed = urls(3, "U1");
        mixed[2] = urls(3, "U2").pop().unwrap();
        assert_eq!(
            check_parts(&mixed, size, PART_SIZE, HOST),
            Err(UploadError::Refused("one upload"))
        );
        let mut evil = urls(3, "U1");
        evil[1].url = evil[1].url.replace(HOST, "evil.test");
        assert_eq!(
            check_parts(&evil, size, PART_SIZE, HOST),
            Err(UploadError::Refused("part address"))
        );
        let mut order = urls(3, "U1");
        order.swap(0, 1);
        assert_eq!(
            check_parts(&order, size, PART_SIZE, HOST),
            Err(UploadError::Refused("part order"))
        );
        assert_eq!(
            check_parts(&urls(3, "U1"), size, PART_SIZE, ""),
            Err(UploadError::Refused("part address"))
        );
    }

    #[test]
    fn parts_are_sent_from_the_file_and_resume_after_a_stop() {
        let dir = std::env::temp_dir().join(format!("cf-upload-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("video.mp4");
        // Small parts would be refused; the fake checks lengths with the real part size on a sparse file.
        let size = PART_SIZE + 10;
        fs::File::create(&file).unwrap().set_len(size).unwrap();
        let record = dir.join("parts.json");
        let fake = Fake::default();
        *fake.fail_first.borrow_mut() = 1; // one 503, tried again
        let mut seen = Vec::new();
        let tags = send(
            &file,
            &urls(2, "U1"),
            PART_SIZE,
            HOST,
            &record,
            &fake,
            &AtomicBool::new(false),
            |b| seen.push(b),
        )
        .unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(
            fake.calls
                .borrow()
                .iter()
                .map(|c| c.1 as u64)
                .collect::<Vec<_>>(),
            [PART_SIZE, 10]
        );
        assert_eq!(*seen.last().unwrap(), size);
        // Sent again for the same upload: nothing goes out twice, the same ETags come back.
        let again = send(
            &file,
            &urls(2, "U1"),
            PART_SIZE,
            HOST,
            &record,
            &fake,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(again, tags);
        assert_eq!(fake.calls.borrow().len(), 2);
        // A new upload id starts over.
        send(
            &file,
            &urls(2, "U9"),
            PART_SIZE,
            HOST,
            &record,
            &fake,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(fake.calls.borrow().len(), 4);
        assert_eq!(
            send(
                &file,
                &urls(2, "U8"),
                PART_SIZE,
                HOST,
                &record,
                &fake,
                &AtomicBool::new(true),
                |_| {}
            ),
            Err(UploadError::Canceled)
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
