//! The pinned tools a fetch runs: yt-dlp, Deno, ffmpeg and ffprobe (docs/CONTRACTS.md §35.4, ADR-59).
//!
//! They are not in the installer. The first fetch (and every later one) reads `downloads/tools/tools.json` and its
//! ed25519 signature `tools.json.sig` from the app's own CloudFront, checks the signature with the public key built
//! in below, refuses a manifest older than the last one it accepted or a yt-dlp older than `MIN_YT_DLP`, downloads
//! any file it does not have yet from the same host, checks its size and SHA-256, and moves it into place whole.
//! It never runs `yt-dlp -U` and never downloads anything from GitHub or elsewhere.
//!
//! When the manifest cannot be read (offline), the last accepted manifest (saved with its signature) is checked
//! again and used. Files are hashed again before every fetch, so a changed file is replaced, never run.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::check::ToolPaths;

/// The manifest's signing key (the private half is only the GitHub Actions secret `CF_TOOLS_SIGNING_KEY`). This is
/// not the updater's key; that one is never used here.
pub const PUBLIC_KEY: &str = "khXBpiJBTgsmjDan8UN8DDd+V61yqKX/WUpcsyjFsaM=";
/// The one host tools come from: the app's own CloudFront (the same host the updater uses).
pub const TOOLS_HOST: &str = crate::update::UPDATE_HOST;
pub const MANIFEST_URL: &str = "https://dglrbjmf28m6c.cloudfront.net/downloads/tools/tools.json";
/// The oldest yt-dlp this app runs: the one the cloud agent has (agent/pyproject.toml).
pub const MIN_YT_DLP: &str = "2026.10.26";
const SCHEMA: u64 = 1;
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_TOOL: u64 = 400 * 1024 * 1024;
const NAMES: [&str; 4] = ["yt-dlp", "deno", "ffmpeg", "ffprobe"];

#[derive(Debug, PartialEq, Eq)]
pub enum ToolError {
    /// The signature, the shape, a host or a version is wrong: nothing is installed or run.
    Untrusted(&'static str),
    /// A file did not match its size or SHA-256.
    BadFile(String),
    /// Nothing could be read and no earlier manifest is saved.
    Offline(String),
    /// This computer is not one of the platforms the manifest covers.
    Unsupported,
    Io(String),
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ToolError::Untrusted(why) => write!(f, "tool manifest refused: {why}"),
            ToolError::BadFile(name) => write!(f, "tool file {name} does not match its sum"),
            ToolError::Offline(e) => write!(f, "tool manifest could not be read: {e}"),
            ToolError::Unsupported => write!(f, "no tools for this computer"),
            ToolError::Io(e) => write!(f, "tool files: {e}"),
        }
    }
}

impl From<std::io::Error> for ToolError {
    fn from(e: std::io::Error) -> Self {
        ToolError::Io(e.to_string())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct FileEntry {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Tool {
    pub version: String,
    pub files: BTreeMap<String, FileEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Manifest {
    pub schema: u64,
    pub serial: u64,
    pub tools: BTreeMap<String, Tool>,
}

/// The manifest key for this computer, or None (Linux, 32-bit, Windows on Arm).
pub fn platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("macos-aarch64"),
        ("macos", "x86_64") => Some("macos-x86_64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        _ => None,
    }
}

/// Checks `sig_b64` over the exact bytes of the manifest with `public_key_b64`, then its shape. Nothing in an
/// unsigned or wrongly signed manifest is ever looked at.
pub fn verify(bytes: &[u8], sig_b64: &str, public_key_b64: &str) -> Result<Manifest, ToolError> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let key: [u8; 32] = b64
        .decode(public_key_b64.trim())
        .ok()
        .and_then(|k| k.try_into().ok())
        .ok_or(ToolError::Untrusted("bad public key"))?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| ToolError::Untrusted("bad public key"))?;
    let sig: [u8; 64] = b64
        .decode(sig_b64.trim())
        .ok()
        .and_then(|s| s.try_into().ok())
        .ok_or(ToolError::Untrusted("bad signature"))?;
    key.verify(bytes, &Signature::from_bytes(&sig))
        .map_err(|_| ToolError::Untrusted("signature does not match"))?;
    let manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|_| ToolError::Untrusted("not a manifest"))?;
    if manifest.schema != SCHEMA {
        return Err(ToolError::Untrusted("unknown manifest schema"));
    }
    Ok(manifest)
}

/// Dotted numbers compared as numbers ("2026.10.26" < "2026.11.2").
fn version_at_least(version: &str, min: &str) -> bool {
    let parse = |v: &str| -> Option<Vec<u64>> { v.split('.').map(|p| p.parse().ok()).collect() };
    match (parse(version), parse(min)) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}

fn host_ok(url: &str) -> bool {
    tauri::Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str() == Some(TOOLS_HOST)
            && u.port().is_none()
            && u.username().is_empty()
            && u.path().starts_with("/downloads/tools/")
            && u.query().is_none()
    })
}

fn safe_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// The checks after the signature: not older than the last accepted manifest (`last_serial`), every tool present for
/// `platform`, files only on our host, a sum of 64 hex digits, a sane size, and yt-dlp at least `MIN_YT_DLP`.
pub fn accept<'m>(
    manifest: &'m Manifest,
    platform: &str,
    last_serial: Option<u64>,
) -> Result<BTreeMap<&'static str, (&'m Tool, &'m FileEntry)>, ToolError> {
    if last_serial.is_some_and(|last| manifest.serial < last) {
        return Err(ToolError::Untrusted(
            "older than the manifest already in use",
        ));
    }
    let mut out = BTreeMap::new();
    for name in NAMES {
        let tool = manifest
            .tools
            .get(name)
            .ok_or(ToolError::Untrusted("a tool is missing"))?;
        if !safe_part(&tool.version) {
            return Err(ToolError::Untrusted("bad version"));
        }
        let file = tool.files.get(platform).ok_or(ToolError::Unsupported)?;
        if !host_ok(&file.url) {
            return Err(ToolError::Untrusted("a file is not on the app's own host"));
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(ToolError::Untrusted("bad sum"));
        }
        if file.size == 0 || file.size > MAX_TOOL {
            return Err(ToolError::Untrusted("bad size"));
        }
        out.insert(name, (tool, file));
    }
    let (yt, _) = out["yt-dlp"];
    if !version_at_least(&yt.version, MIN_YT_DLP) {
        return Err(ToolError::Untrusted("yt-dlp is older than this app allows"));
    }
    Ok(out)
}

/// Where the bytes come from: the network in the app, a folder in tests and in the local proof run.
pub trait Source {
    /// The whole body of `url`, at most `max` bytes.
    fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String>;
    /// Streams `url` into `to`, at most `max` bytes.
    fn get_to(&self, url: &str, to: &mut dyn Write, max: u64) -> Result<u64, String>;
}

/// The app's source: blocking https, no redirects (a redirect could leave our host).
pub struct Http(reqwest::blocking::Client);

impl Http {
    pub fn new() -> Result<Http, String> {
        reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .user_agent(concat!("ClipFactoryDesktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map(Http)
            .map_err(|e| e.to_string())
    }
}

impl Source for Http {
    fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        self.get_to(url, &mut out, max)?;
        Ok(out)
    }

    fn get_to(&self, url: &str, to: &mut dyn Write, max: u64) -> Result<u64, String> {
        let r = self
            .0
            .get(url)
            .send()
            .map_err(|e| e.without_url().to_string())?;
        if !r.status().is_success() {
            return Err(format!("status {}", r.status().as_u16()));
        }
        let n = std::io::copy(&mut r.take(max + 1), to).map_err(|e| e.to_string())?;
        if n > max {
            return Err("too large".into());
        }
        Ok(n)
    }
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(&h.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The saved manifest (the last one accepted), with its signature: reused when the network is down.
const SAVED: &str = "tools.json";
const SAVED_SIG: &str = "tools.json.sig";

/// Makes sure every tool for this computer is installed in `dir` and matches the signed manifest; returns where they
/// are. `public_key` is `PUBLIC_KEY` in the app (tests pass their own).
pub fn ensure(dir: &Path, source: &dyn Source, public_key: &str) -> Result<ToolPaths, ToolError> {
    use fs4::fs_std::FileExt;
    platform().ok_or(ToolError::Unsupported)?;
    fs::create_dir_all(dir)?;
    // Two fetches may start together (the page starts every waiting job at once): one installs while the other
    // waits, so neither reads a half-written temp file or renames one that the other is still filling. The lock is
    // let go when the file closes, also when this process stops.
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".install.lock"))?;
    lock.lock_exclusive()?;
    let result = ensure_locked(dir, source, public_key);
    let _ = FileExt::unlock(&lock);
    result
}

fn ensure_locked(
    dir: &Path,
    source: &dyn Source,
    public_key: &str,
) -> Result<ToolPaths, ToolError> {
    let platform = platform().ok_or(ToolError::Unsupported)?;
    let saved = read_saved(dir, public_key);
    let fresh = source.get(MANIFEST_URL, MAX_MANIFEST).and_then(|bytes| {
        let sig = source.get(&format!("{MANIFEST_URL}.sig"), 1024)?;
        Ok((bytes, String::from_utf8_lossy(&sig).into_owned()))
    });
    let (bytes, sig, manifest) = match fresh {
        Ok((bytes, sig)) => {
            let manifest = verify(&bytes, &sig, public_key)?;
            (bytes, sig, manifest)
        }
        Err(e) => match saved.as_ref() {
            Some((b, s, m)) => (b.clone(), s.clone(), m.clone()),
            None => return Err(ToolError::Offline(e)),
        },
    };
    let last = saved.as_ref().map(|(_, _, m)| m.serial);
    let files = accept(&manifest, platform, last)?;
    let mut paths = BTreeMap::new();
    for (name, (tool, file)) in &files {
        let file_name = tauri::Url::parse(&file.url)
            .ok()
            .and_then(|u| u.path_segments()?.next_back().map(str::to_owned))
            .filter(|n| safe_part(n))
            .ok_or(ToolError::Untrusted("bad file name"))?;
        let folder = dir.join(name).join(&tool.version);
        let path = folder.join(&file_name);
        install(source, file, &path)?;
        paths.insert(*name, path);
    }
    // Saved only after every file is in place, so the saved manifest always names files that are there.
    write_whole(&dir.join(SAVED), &bytes)?;
    write_whole(&dir.join(SAVED_SIG), sig.as_bytes())?;
    // yt-dlp is told the folder of ffmpeg and looks for ffprobe there: a checked copy sits beside it.
    let ffmpeg_dir = paths["ffmpeg"]
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    link_ffprobe(&paths["ffprobe"], &ffmpeg_dir)?;
    Ok(ToolPaths {
        yt_dlp: paths["yt-dlp"].clone(),
        deno: paths["deno"].clone(),
        ffmpeg_dir,
    })
}

/// yt-dlp looks for ffprobe in the folder it is given for ffmpeg: keep a checked copy there.
fn link_ffprobe(ffprobe: &Path, ffmpeg_dir: &Path) -> std::io::Result<()> {
    let Some(name) = ffprobe.file_name() else {
        return Ok(());
    };
    let target = ffmpeg_dir.join(name);
    let same = fs::metadata(&target)
        .is_ok_and(|m| fs::metadata(ffprobe).is_ok_and(|f| f.len() == m.len()))
        && sha256_of(&target).ok() == sha256_of(ffprobe).ok();
    if !same {
        let tmp = ffmpeg_dir.join(".ffprobe.tmp");
        fs::copy(ffprobe, &tmp)?;
        make_executable(&tmp)?;
        fs::rename(&tmp, &target)?;
    }
    Ok(())
}

fn read_saved(dir: &Path, public_key: &str) -> Option<(Vec<u8>, String, Manifest)> {
    let bytes = fs::read(dir.join(SAVED)).ok()?;
    let sig = fs::read_to_string(dir.join(SAVED_SIG)).ok()?;
    let manifest = verify(&bytes, &sig, public_key).ok()?;
    Some((bytes, sig, manifest))
}

/// One file in place: kept when it already matches, else downloaded beside it, checked, and renamed over it.
fn install(source: &dyn Source, file: &FileEntry, path: &Path) -> Result<(), ToolError> {
    let want = file.sha256.to_ascii_lowercase();
    if fs::metadata(path).is_ok_and(|m| m.len() == file.size) && sha256_of(path)? == want {
        return Ok(());
    }
    let folder = path.parent().ok_or(ToolError::Io("no folder".into()))?;
    fs::create_dir_all(folder)?;
    let tmp = folder.join(".download.tmp");
    let result = (|| {
        let mut out = fs::File::create(&tmp)?;
        let n = source
            .get_to(&file.url, &mut out, file.size)
            .map_err(ToolError::Offline)?;
        out.sync_all()?;
        drop(out);
        let name = path.display().to_string();
        if n != file.size || sha256_of(&tmp)? != want {
            return Err(ToolError::BadFile(name));
        }
        make_executable(&tmp)?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn write_whole(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::path::PathBuf;

    pub fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    pub fn public_b64(key: &SigningKey) -> String {
        base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes())
    }

    fn sign(key: &SigningKey, bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(key.sign(bytes).to_bytes())
    }

    /// A source made of fixed bodies; counts what was fetched.
    #[derive(Default)]
    pub struct Fake {
        pub bodies: HashMap<String, Vec<u8>>,
        pub fetched: RefCell<Vec<String>>,
    }

    impl Source for Fake {
        fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
            let mut out = Vec::new();
            self.get_to(url, &mut out, max)?;
            Ok(out)
        }
        fn get_to(&self, url: &str, to: &mut dyn Write, max: u64) -> Result<u64, String> {
            self.fetched.borrow_mut().push(url.to_owned());
            let body = self.bodies.get(url).ok_or("offline")?;
            if body.len() as u64 > max {
                return Err("too large".into());
            }
            to.write_all(body).map_err(|e| e.to_string())?;
            Ok(body.len() as u64)
        }
    }

    fn file_url(name: &str, version: &str, file: &str) -> String {
        format!(
            "https://{TOOLS_HOST}/downloads/tools/{name}/{version}/{}/{file}",
            platform().unwrap()
        )
    }

    /// A signed manifest for this computer with tiny files, and the source that serves it.
    pub fn signed(serial: u64, yt_version: &str, key: &SigningKey) -> (Fake, Manifest) {
        let mut fake = Fake::default();
        let mut tools = BTreeMap::new();
        for name in NAMES {
            let version = if name == "yt-dlp" {
                yt_version
            } else {
                "1.0.0"
            };
            let body = format!("#!/bin/sh\necho {name} {version}\n").into_bytes();
            let url = file_url(name, version, name);
            let entry = FileEntry {
                url: url.clone(),
                sha256: hex(&Sha256::digest(&body)),
                size: body.len() as u64,
            };
            fake.bodies.insert(url, body);
            let mut files = BTreeMap::new();
            files.insert(platform().unwrap().to_owned(), entry);
            tools.insert(
                name.to_owned(),
                Tool {
                    version: version.to_owned(),
                    files,
                },
            );
        }
        let manifest = Manifest {
            schema: 1,
            serial,
            tools,
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fake.bodies.insert(
            format!("{MANIFEST_URL}.sig"),
            sign(key, &bytes).into_bytes(),
        );
        fake.bodies.insert(MANIFEST_URL.to_owned(), bytes);
        (fake, manifest)
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cf-tools-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    /// A source that can be shared by two threads and is slow in the middle of every file, so two unlocked installs
    /// would overlap on the same temp file.
    struct Slow {
        bodies: HashMap<String, Vec<u8>>,
        fetched: std::sync::Mutex<Vec<String>>,
    }

    impl Source for Slow {
        fn get(&self, url: &str, max: u64) -> Result<Vec<u8>, String> {
            let mut out = Vec::new();
            self.get_to(url, &mut out, max)?;
            Ok(out)
        }
        fn get_to(&self, url: &str, to: &mut dyn Write, max: u64) -> Result<u64, String> {
            self.fetched.lock().unwrap().push(url.to_owned());
            let body = self.bodies.get(url).ok_or("offline")?;
            if body.len() as u64 > max {
                return Err("too large".into());
            }
            let half = body.len() / 2;
            to.write_all(&body[..half]).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(40));
            to.write_all(&body[half..]).map_err(|e| e.to_string())?;
            Ok(body.len() as u64)
        }
    }

    #[test]
    fn two_fetches_starting_together_install_once_and_both_get_good_tools() {
        if platform().is_none() {
            return;
        }
        let key = test_key();
        let (fake, _) = signed(3, "2026.10.26", &key);
        let slow = Slow {
            bodies: fake.bodies,
            fetched: Default::default(),
        };
        let dir = tmp("together");
        let public = public_b64(&key);
        let (a, b) = std::thread::scope(|s| {
            let one = s.spawn(|| ensure(&dir, &slow, &public));
            let two = s.spawn(|| ensure(&dir, &slow, &public));
            (one.join().unwrap(), two.join().unwrap())
        });
        let (a, b) = (a.expect("first"), b.expect("second"));
        assert_eq!(a.yt_dlp, b.yt_dlp);
        assert_eq!(
            fs::read_to_string(&a.yt_dlp).unwrap(),
            "#!/bin/sh\necho yt-dlp 2026.10.26\n",
            "a whole file, never a half-written one"
        );
        // The four files were downloaded once (the one that waited found them in place); each run read the manifest.
        let fetched = slow.fetched.lock().unwrap();
        let files = fetched.iter().filter(|u| !u.contains("tools.json")).count();
        assert_eq!(files, 4, "{fetched:?}");
    }

    #[test]
    fn a_signed_manifest_installs_every_tool_and_reuses_them() {
        if platform().is_none() {
            return;
        }
        let key = test_key();
        let (fake, _) = signed(3, "2026.10.26", &key);
        let dir = tmp("install");
        let paths = ensure(&dir, &fake, &public_b64(&key)).expect("installed");
        assert!(paths.yt_dlp.is_file());
        assert!(paths.deno.is_file());
        assert!(paths.ffmpeg_dir.join("ffmpeg").is_file());
        assert!(
            paths.ffmpeg_dir.join("ffprobe").is_file(),
            "ffprobe beside ffmpeg"
        );
        let downloads = fake.fetched.borrow().len();
        assert_eq!(downloads, 2 + 4);
        // A second fetch reads the manifest again but downloads no file.
        ensure(&dir, &fake, &public_b64(&key)).unwrap();
        assert_eq!(fake.fetched.borrow().len(), downloads + 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_wrong_signature_or_key_installs_nothing() {
        let key = test_key();
        let (mut fake, manifest) = signed(1, "2026.10.26", &key);
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let dir = tmp("badsig");
        assert_eq!(
            ensure(&dir, &fake, &public_b64(&other)).unwrap_err(),
            ToolError::Untrusted("signature does not match")
        );
        // The manifest changed after signing (a file swapped for another).
        let mut changed = manifest.clone();
        changed.serial = 2;
        fake.bodies
            .insert(MANIFEST_URL.into(), serde_json::to_vec(&changed).unwrap());
        assert!(matches!(
            ensure(&dir, &fake, &public_b64(&key)),
            Err(ToolError::Untrusted(_))
        ));
        fake.bodies
            .insert(format!("{MANIFEST_URL}.sig"), b"not base64!".to_vec());
        assert_eq!(
            ensure(&dir, &fake, &public_b64(&key)).unwrap_err(),
            ToolError::Untrusted("bad signature")
        );
        assert!(!dir.join("yt-dlp").exists(), "nothing installed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_that_does_not_match_its_sum_is_never_kept() {
        if platform().is_none() {
            return;
        }
        let key = test_key();
        let (mut fake, manifest) = signed(1, "2026.10.26", &key);
        let url = manifest.tools["deno"].files[platform().unwrap()]
            .url
            .clone();
        fake.bodies.insert(url, b"#!/bin/sh\necho evil!\n".to_vec());
        let dir = tmp("badfile");
        assert!(matches!(
            ensure(&dir, &fake, &public_b64(&key)),
            Err(ToolError::BadFile(_))
        ));
        let deno = dir.join("deno").join("1.0.0");
        assert!(!deno.join("deno").exists());
        assert!(!deno.join(".download.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_manifest_or_yt_dlp_is_refused() {
        let key = test_key();
        let (_, m) = signed(5, "2026.10.26", &key);
        let p = platform().unwrap_or("macos-aarch64");
        if platform().is_some() {
            assert!(accept(&m, p, Some(5)).is_ok());
            assert!(accept(&m, p, Some(4)).is_ok());
            assert_eq!(
                accept(&m, p, Some(6)).unwrap_err(),
                ToolError::Untrusted("older than the manifest already in use")
            );
            let (_, old) = signed(9, "2025.12.31", &key);
            assert_eq!(
                accept(&old, p, None).unwrap_err(),
                ToolError::Untrusted("yt-dlp is older than this app allows")
            );
            let (_, newer) = signed(9, "2026.11.2", &key);
            assert!(accept(&newer, p, None).is_ok());
            assert_eq!(
                accept(&m, "linux-riscv", None).unwrap_err(),
                ToolError::Unsupported
            );
        }
        assert!(version_at_least("2026.10.26", "2026.10.26"));
        assert!(version_at_least("2026.11.2", "2026.10.26"));
        assert!(!version_at_least("2026.9.30", "2026.10.26"));
        assert!(!version_at_least("nightly", "2026.10.26"));
    }

    #[test]
    fn files_only_come_from_the_apps_own_host() {
        assert!(host_ok(&format!(
            "https://{TOOLS_HOST}/downloads/tools/yt-dlp/1/macos-aarch64/yt-dlp"
        )));
        for bad in [
            "http://dglrbjmf28m6c.cloudfront.net/downloads/tools/x".to_owned(),
            "https://github.com/yt-dlp/yt-dlp/releases/download/x/yt-dlp".to_owned(),
            format!("https://{TOOLS_HOST}.evil.test/downloads/tools/x"),
            format!("https://{TOOLS_HOST}/other/x"),
            format!("https://{TOOLS_HOST}:444/downloads/tools/x"),
            format!("https://{TOOLS_HOST}/downloads/tools/x?redirect=1"),
        ] {
            assert!(!host_ok(&bad), "{bad}");
        }
        let key = test_key();
        let (_, mut m) = signed(1, "2026.10.26", &key);
        if let Some(p) = platform() {
            m.tools
                .get_mut("ffmpeg")
                .unwrap()
                .files
                .get_mut(p)
                .unwrap()
                .url = "https://evil.test/downloads/tools/ffmpeg".into();
            assert_eq!(
                accept(&m, p, None).unwrap_err(),
                ToolError::Untrusted("a file is not on the app's own host")
            );
        }
    }

    #[test]
    fn offline_uses_the_last_accepted_manifest() {
        if platform().is_none() {
            return;
        }
        let key = test_key();
        let (fake, _) = signed(2, "2026.10.26", &key);
        let dir = tmp("offline");
        ensure(&dir, &fake, &public_b64(&key)).unwrap();
        let offline = Fake::default();
        assert!(
            ensure(&dir, &offline, &public_b64(&key)).is_ok(),
            "saved manifest and files reused"
        );
        let empty = tmp("offline-empty");
        assert!(matches!(
            ensure(&empty, &offline, &public_b64(&key)),
            Err(ToolError::Offline(_))
        ));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn the_built_in_key_is_a_valid_ed25519_key() {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(PUBLIC_KEY)
            .unwrap();
        let raw: [u8; 32] = raw.try_into().unwrap();
        assert!(VerifyingKey::from_bytes(&raw).is_ok());
        assert_eq!(
            MANIFEST_URL,
            format!("https://{TOOLS_HOST}/downloads/tools/tools.json")
        );
    }
}
