//! The one-time sign-in door (docs/CONTRACTS.md §38.15). Content Rewards only sends a sign-in back to
//! `http://127.0.0.1`, so for one sign-in this app listens on this computer, and only on this computer, for the
//! browser to come back with `?code&state`. A thread on `std::net::TcpListener` (no new crate):
//!
//! * binds `127.0.0.1` (never `0.0.0.0` or `::`) on the first free port of the list it is given;
//! * reads one request head per connection (at most 8 KB, 5 s), takes only `GET` with `Host` exactly
//!   `127.0.0.1:{port}` on the path `/`, and only an answer whose `state` is the one the door was opened with;
//! * answers anything else with a plain 404 or 400 and stays open;
//! * closes after one good answer, a cancel, or its time (5 minutes).
//!
//! The code and state stay in memory until `read` hands them over, once. They are never logged or written to disk.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddrV4, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::Url;

use super::check;

/// The five ways back registered with Content Rewards (§38.9 `PORTS`), tried in this order.
pub const PORTS: [u16; 5] = [47811, 47812, 47813, 47814, 47815];
/// How long a door stays open.
pub const OPEN_FOR: Duration = Duration::from_secs(5 * 60);
/// How long one connection may take to send its request head.
pub const HEAD_TIME: Duration = Duration::from_secs(5);
/// The most a request head may be.
pub const MAX_HEAD: usize = 8 * 1024;
/// The most connections read at once (a browser opens a few spare ones).
const MAX_CONNECTIONS: usize = 8;
/// How often the door looks for a new connection, a cancel or its time.
const TICK: Duration = Duration::from_millis(20);

/// A clock that only goes forward, so the door's time can be moved in tests.
pub trait Clock: Send + Sync {
    /// Time since some fixed start.
    fn now(&self) -> Duration;
}

/// The real clock.
pub struct SystemClock(Instant);

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock(Instant::now())
    }
}

impl Clock for SystemClock {
    fn now(&self) -> Duration {
        self.0.elapsed()
    }
}

/// Where and for how long a door opens.
#[derive(Clone)]
pub struct Config {
    pub ports: Vec<u16>,
    pub open_for: Duration,
    pub head_time: Duration,
    pub clock: Arc<dyn Clock>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            ports: PORTS.to_vec(),
            open_for: OPEN_FOR,
            head_time: HEAD_TIME,
            clock: Arc::new(SystemClock::default()),
        }
    }
}

/// No port of the list was free (the command answers `no_port`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NoPort;

/// The door was already opened for a sign-in, or already answered (the command answers `busy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Busy;

/// A good answer from the browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answer {
    pub state: String,
    pub iss: Option<String>,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// Content Rewards said yes: the one-time code.
    Code(String),
    /// Content Rewards said no: its error code and, maybe, its words (printable, at most 300 characters).
    Error {
        error: String,
        description: Option<String>,
    },
}

/// What the door has, as `read` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    /// Open, no answer yet.
    Waiting,
    /// The answer, handed over once.
    Answered(Answer),
    /// Its time ran out before an answer came.
    Expired,
}

/// What a request gets back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    /// 200, the "Done!" page.
    Done,
    /// 200, the "didn't connect" page.
    Failed,
    BadRequest,
    NotFound,
}

/// What one request head asks for, before the door's own `state` is looked at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    Answer(Answer),
    BadRequest,
    NotFound,
}

#[derive(Default)]
struct Inner {
    /// The `state` of the address `cr_connect_open` opened.
    expected: Option<String>,
    /// The good answer, until `read` takes it.
    answer: Option<Answer>,
    /// A good answer came (and may already be taken): nothing more is accepted.
    answered: bool,
}

struct Shared {
    port: u16,
    clock: Arc<dyn Clock>,
    closes_at: Duration,
    head_time: Duration,
    inner: Mutex<Inner>,
    /// Set by a good answer, a cancel or the door being dropped: the listening thread stops.
    stop: AtomicBool,
    connections: AtomicUsize,
    on_answer: Box<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn expired(&self) -> bool {
        self.clock.now() >= self.closes_at
    }

    /// Takes a well-formed answer if it carries the door's `state` and the door still takes answers.
    fn offer(&self, answer: Answer) -> Reply {
        let mut inner = self.lock();
        let open = !inner.answered && !self.stop.load(Ordering::SeqCst) && !self.expired();
        let matches = inner
            .expected
            .as_deref()
            .is_some_and(|expected| check::same(expected, &answer.state));
        if !open || !matches {
            return Reply::BadRequest;
        }
        let reply = match answer.kind {
            Kind::Code(_) => Reply::Done,
            Kind::Error { .. } => Reply::Failed,
        };
        inner.answer = Some(answer);
        inner.answered = true;
        self.stop.store(true, Ordering::SeqCst);
        reply
    }
}

/// An open door. Dropping it closes it.
pub struct Door {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Door {
    /// Binds `127.0.0.1` on the first free port of `config.ports` and starts listening. `on_answer` runs once, after
    /// the browser got its page for a good answer (the app brings its window to the front).
    pub fn open(config: &Config, on_answer: Box<dyn Fn() + Send + Sync>) -> Result<Door, NoPort> {
        let (listener, port) = config
            .ports
            .iter()
            .find_map(|&port| {
                TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
                    .ok()
                    .map(|l| (l, port))
            })
            .ok_or(NoPort)?;
        listener.set_nonblocking(true).map_err(|_| NoPort)?;
        let shared = Arc::new(Shared {
            port,
            clock: config.clock.clone(),
            closes_at: config.clock.now() + config.open_for,
            head_time: config.head_time,
            inner: Mutex::new(Inner::default()),
            stop: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            on_answer,
        });
        let worker = shared.clone();
        let thread = std::thread::Builder::new()
            .name("cr-connect-door".into())
            .spawn(move || listen(listener, worker))
            .map_err(|_| NoPort)?;
        Ok(Door {
            shared,
            thread: Some(thread),
        })
    }

    pub fn port(&self) -> u16 {
        self.shared.port
    }

    /// Remembers the `state` of the address being opened. Once per door.
    pub fn expect(&self, state: String) -> Result<(), Busy> {
        let mut inner = self.shared.lock();
        if inner.expected.is_some() || inner.answered {
            return Err(Busy);
        }
        inner.expected = Some(state);
        Ok(())
    }

    /// The answer (handed over once), or whether the door still waits or ran out of time.
    pub fn read(&self) -> Reading {
        let mut inner = self.shared.lock();
        if let Some(answer) = inner.answer.take() {
            return Reading::Answered(answer);
        }
        if !inner.answered && self.shared.expired() {
            self.shared.stop.store(true, Ordering::SeqCst);
            return Reading::Expired;
        }
        Reading::Waiting
    }

    /// Whether the time ran out before an answer came.
    pub fn expired(&self) -> bool {
        !self.shared.lock().answered && self.shared.expired()
    }
}

impl Drop for Door {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        // The listening thread wakes every TICK, so the port is free again right after this.
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The listening thread: hands each connection to its own short thread until the door closes.
fn listen(listener: TcpListener, shared: Arc<Shared>) {
    while !shared.stop.load(Ordering::SeqCst) && !shared.expired() {
        match listener.accept() {
            Ok((stream, _)) => {
                if shared.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                    shared.connections.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let worker = shared.clone();
                let spawned = std::thread::Builder::new()
                    .name("cr-connect-answer".into())
                    .spawn(move || {
                        serve(stream, &worker);
                        worker.connections.fetch_sub(1, Ordering::SeqCst);
                    });
                if spawned.is_err() {
                    shared.connections.fetch_sub(1, Ordering::SeqCst);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(TICK),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => std::thread::sleep(TICK),
        }
    }
    // The listener is dropped here: the port closes.
}

/// One connection: read its head, answer it, and after a good answer bring the app to the front.
fn serve(mut stream: TcpStream, shared: &Shared) {
    // An accepted socket may inherit the listener's non-blocking mode (macOS does).
    if stream.set_nonblocking(false).is_err() {
        return;
    }
    let reply = match read_head(&mut stream, shared.head_time) {
        Head::Read(head) => match parse_request(&head, shared.port) {
            Parsed::Answer(answer) => shared.offer(answer),
            Parsed::BadRequest => Reply::BadRequest,
            Parsed::NotFound => Reply::NotFound,
        },
        Head::TooLarge => Reply::BadRequest,
        // Nothing came in time (a browser's spare connection): just close it.
        Head::Nothing => return,
    };
    let _ = stream.set_write_timeout(Some(shared.head_time));
    let _ = stream.write_all(&response(reply));
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Write);
    if matches!(reply, Reply::Done | Reply::Failed) {
        (shared.on_answer)();
    }
    // Read what is left before closing, so the browser gets the page rather than a reset.
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = std::io::copy(&mut stream.take(64 * 1024), &mut std::io::sink());
}

enum Head {
    Read(String),
    TooLarge,
    Nothing,
}

/// Reads up to the blank line that ends a request head: at most `MAX_HEAD` bytes, within `time`.
fn read_head(stream: &mut TcpStream, time: Duration) -> Head {
    let deadline = Instant::now() + time;
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            if end + 4 > MAX_HEAD {
                return Head::TooLarge;
            }
            buf.truncate(end);
            return match String::from_utf8(buf) {
                Ok(head) => Head::Read(head),
                Err(_) => Head::TooLarge,
            };
        }
        if buf.len() >= MAX_HEAD {
            return Head::TooLarge;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            return Head::Nothing;
        }
        let room = (MAX_HEAD + 4 - buf.len()).min(chunk.len());
        match stream.read(&mut chunk[..room]) {
            Ok(0) => return Head::Nothing,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Head::Nothing,
        }
    }
}

/// What a request head asks for: only `GET / HTTP/1.x` with `Host: 127.0.0.1:{port}` (once) and a well-formed
/// answer (`code` or `error`, a `state`, maybe `iss` and `error_description`, each at most once; anything else in
/// the query is ignored) is an answer. Another path is a 404; everything else a 400.
pub fn parse_request(head: &str, port: u16) -> Parsed {
    let mut lines = head.split("\r\n");
    let Some(first) = lines.next() else {
        return Parsed::BadRequest;
    };
    let mut parts = first.split(' ');
    let (Some(method), Some(target), Some(version), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Parsed::BadRequest;
    };
    if method != "GET" || !matches!(version, "HTTP/1.1" | "HTTP/1.0") {
        return Parsed::BadRequest;
    }
    let want_host = format!("127.0.0.1:{port}");
    let mut hosts = 0;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Parsed::BadRequest;
        };
        if name.eq_ignore_ascii_case("host") {
            hosts += 1;
            if value.trim_matches([' ', '\t']) != want_host {
                return Parsed::BadRequest;
            }
        }
    }
    if hosts != 1 {
        return Parsed::BadRequest;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/" {
        return Parsed::NotFound;
    }
    if query.contains('#') {
        return Parsed::BadRequest;
    }
    answer_from(query).map_or(Parsed::BadRequest, Parsed::Answer)
}

/// The answer in a query string, if it is a well-formed one.
fn answer_from(query: &str) -> Option<Answer> {
    let url = Url::parse(&format!("http://127.0.0.1/?{query}")).ok()?;
    let (mut code, mut state, mut error, mut description, mut iss) = (None, None, None, None, None);
    for (k, v) in url.query_pairs() {
        let slot = match k.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            "error_description" => &mut description,
            "iss" => &mut iss,
            // Anything else Content Rewards adds is ignored.
            _ => continue,
        };
        if slot.is_some() {
            return None;
        }
        *slot = Some(v.into_owned());
    }
    let state = state.filter(|s| check::state_ok(s))?;
    if iss.as_deref().is_some_and(|i| !check::iss_ok(i)) {
        return None;
    }
    let kind = match (code, error) {
        (Some(code), None) if check::code_ok(&code) => Kind::Code(code),
        (None, Some(error)) if check::error_ok(&error) => Kind::Error {
            error,
            description: description
                .map(|d| check::description(&d))
                .filter(|d| !d.is_empty()),
        },
        _ => return None,
    };
    Some(Answer { state, iss, kind })
}

/// The page the browser shows after a good answer, in the app's colours: bone words on bottle green, soft fills,
/// no edges. It never repeats anything from the request.
fn page(done: bool) -> String {
    let (mark, mark_class, title, line) = if done {
        (
            "&#10003;",
            "yes",
            "Done!",
            "Go back to Clip Factory. You can close this tab.",
        )
    } else {
        (
            "!",
            "no",
            "Content Rewards didn't connect.",
            "Go back to Clip Factory to see what to do.",
        )
    };
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
<meta name=\"referrer\" content=\"no-referrer\"><title>Clip Factory</title><style>\
html{{color-scheme:dark;background:#0f372b}}\
body{{margin:0;min-height:100vh;display:grid;place-items:center;color:#efe7da;\
font:18px/1.5 \"Inter Variable\",Inter,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;\
background:radial-gradient(circle at 30% 20%,#2a5c4a,#0f372b 55%,#0a2820)}}\
main{{box-sizing:border-box;max-width:28rem;margin:1.5rem;padding:2rem 2.25rem;border-radius:28px;\
background:rgb(10 40 32 / .55);box-shadow:0 24px 60px -24px rgb(4 20 15 / .8);text-align:center}}\
.mark{{width:64px;height:64px;margin:0 auto 1rem;border-radius:50%;display:grid;place-items:center;\
font-size:34px;font-weight:700}}\
.yes{{background:#5fa585;color:#0a2820}}.no{{background:#c42a1e;color:#fff}}\
h1{{margin:0 0 .5rem;font:600 1.6rem/1.25 \"Times New Roman\",Tinos,Times,serif}}p{{margin:0}}\
@media (prefers-reduced-motion:no-preference){{main{{animation:rise .35s ease-out}}}}\
@keyframes rise{{from{{opacity:0;transform:translateY(8px)}}}}\
</style></head><body><main><div class=\"mark {mark_class}\" aria-hidden=\"true\">{mark}</div>\
<h1>{title}</h1><p>{line}</p></main></body></html>\n"
    )
}

/// The whole response for `reply`, headers and page.
pub fn response(reply: Reply) -> Vec<u8> {
    let (status, kind, body) = match reply {
        Reply::Done => ("200 OK", "text/html", page(true)),
        Reply::Failed => ("200 OK", "text/html", page(false)),
        Reply::BadRequest => ("400 Bad Request", "text/plain", "Bad request\n".to_owned()),
        Reply::NotFound => ("404 Not Found", "text/plain", "Not found\n".to_owned()),
    };
    format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: {kind}; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Referrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    )
    .into_bytes()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cr_connect::check::tests::{enc, STATE};
    use std::net::SocketAddr;

    /// A clock the test moves by hand.
    #[derive(Default)]
    pub struct FakeClock(Mutex<Duration>);

    impl FakeClock {
        pub fn advance(&self, by: Duration) {
            *self.0.lock().unwrap() += by;
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> Duration {
            *self.0.lock().unwrap()
        }
    }

    /// A port that was free a moment ago, outside the five real ones (so tests never take the app's ports).
    pub fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    pub fn config(ports: Vec<u16>, clock: Arc<FakeClock>) -> Config {
        Config {
            ports,
            open_for: OPEN_FOR,
            head_time: Duration::from_millis(300),
            clock,
        }
    }

    pub struct Opened {
        pub door: Door,
        pub clock: Arc<FakeClock>,
        pub fronts: Arc<AtomicUsize>,
    }

    /// A door on a fresh port, opened for `STATE`.
    pub fn opened() -> Opened {
        let clock = Arc::new(FakeClock::default());
        let fronts = Arc::new(AtomicUsize::new(0));
        let counted = fronts.clone();
        let door = Door::open(
            &config(vec![free_port()], clock.clone()),
            Box::new(move || {
                counted.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("a door");
        door.expect(STATE.to_owned()).unwrap();
        Opened {
            door,
            clock,
            fronts,
        }
    }

    /// Sends `head` (the blank line is added) to the door and returns the whole response, or None when the
    /// connection was refused or closed without one.
    pub fn send(port: u16, head: &str) -> Option<String> {
        let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        s.write_all(format!("{head}\r\n\r\n").as_bytes()).ok()?;
        let mut out = String::new();
        s.read_to_string(&mut out).ok()?;
        (!out.is_empty()).then_some(out)
    }

    pub fn get(port: u16, target: &str) -> Option<String> {
        send(
            port,
            &format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUser-Agent: test"),
        )
    }

    fn status(response: &Option<String>) -> &str {
        response
            .as_deref()
            .and_then(|r| r.split("\r\n").next())
            .unwrap_or("no answer")
    }

    /// Waits a little for the door to see a change (its thread wakes every TICK).
    pub fn soon(mut ready: impl FnMut() -> bool) -> bool {
        for _ in 0..100 {
            if ready() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn the_real_ports_are_the_five_registered_ways_back() {
        assert_eq!(PORTS, [47811, 47812, 47813, 47814, 47815]);
        assert_eq!(OPEN_FOR, Duration::from_secs(300));
        assert_eq!(HEAD_TIME, Duration::from_secs(5));
        assert_eq!(MAX_HEAD, 8192);
        assert_eq!(Config::default().ports, PORTS.to_vec());
    }

    #[test]
    fn the_door_listens_on_this_computer_only() {
        let o = opened();
        let port = o.door.port();
        // 127.0.0.1 answers; the IPv6 loopback (what `::` would add) does not.
        assert_eq!(status(&get(port, "/favicon.ico")), "HTTP/1.1 404 Not Found");
        let v6 = SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port));
        assert!(TcpStream::connect_timeout(&v6, Duration::from_millis(300)).is_err());
        // Nothing else can take the same address while the door is open.
        assert!(TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_err());
    }

    #[test]
    fn a_busy_port_is_skipped_and_none_free_is_no_port() {
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let busy = taken.local_addr().unwrap().port();
        let next = free_port();
        let clock = Arc::new(FakeClock::default());
        let door = Door::open(&config(vec![busy, next], clock.clone()), Box::new(|| {})).unwrap();
        assert_eq!(door.port(), next);
        let none = Door::open(&config(vec![busy], clock.clone()), Box::new(|| {}));
        assert_eq!(none.err(), Some(NoPort));
        assert_eq!(
            Door::open(&config(vec![], clock), Box::new(|| {})).err(),
            Some(NoPort)
        );
    }

    #[test]
    fn a_good_code_is_taken_once_with_the_done_page_and_the_app_comes_forward() {
        let o = opened();
        let port = o.door.port();
        assert_eq!(o.door.read(), Reading::Waiting);
        let r = get(port, &format!("/?code=abc.DEF_1~%2B%2F%3D-&state={STATE}"));
        assert_eq!(status(&r), "HTTP/1.1 200 OK");
        assert!(r.unwrap().contains("<h1>Done!</h1>"));
        assert!(soon(|| o.fronts.load(Ordering::SeqCst) == 1));
        assert_eq!(
            o.door.read(),
            Reading::Answered(Answer {
                state: STATE.to_owned(),
                iss: None,
                kind: Kind::Code("abc.DEF_1~+/=-".to_owned()),
            })
        );
        // Handed over once.
        assert_eq!(o.door.read(), Reading::Waiting);
        // One answer only: the door closed, a second good answer is never taken.
        let again = get(port, &format!("/?code=second&state={STATE}"));
        assert_ne!(status(&again), "HTTP/1.1 200 OK");
        assert_eq!(o.door.read(), Reading::Waiting);
        assert!(soon(|| TcpStream::connect(("127.0.0.1", port)).is_err()));
        assert_eq!(o.fronts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_wrong_state_is_refused_and_the_right_one_is_still_taken() {
        let o = opened();
        let port = o.door.port();
        for wrong in ["other", &STATE[1..], &format!("{STATE}x"), ""] {
            let r = get(port, &format!("/?code=abc&state={wrong}"));
            assert_eq!(status(&r), "HTTP/1.1 400 Bad Request", "{wrong}");
        }
        assert_eq!(status(&get(port, "/?code=abc")), "HTTP/1.1 400 Bad Request");
        assert_eq!(o.door.read(), Reading::Waiting);
        let r = get(port, &format!("/?code=abc&state={STATE}"));
        assert_eq!(status(&r), "HTTP/1.1 200 OK");
        assert!(matches!(o.door.read(), Reading::Answered(_)));
    }

    #[test]
    fn no_answer_is_taken_before_the_door_knows_its_state() {
        let clock = Arc::new(FakeClock::default());
        let door = Door::open(&config(vec![free_port()], clock), Box::new(|| {})).unwrap();
        let r = get(door.port(), &format!("/?code=abc&state={STATE}"));
        assert_eq!(status(&r), "HTTP/1.1 400 Bad Request");
        // Once per door.
        door.expect(STATE.to_owned()).unwrap();
        assert_eq!(door.expect(STATE.to_owned()), Err(Busy));
    }

    #[test]
    fn a_wrong_host_another_path_or_method_is_refused_and_the_door_stays_open() {
        let o = opened();
        let port = o.door.port();
        let good = format!("/?code=abc&state={STATE}");
        for (head, want) in [
            (
                format!("GET {good} HTTP/1.1\r\nHost: localhost:{port}"),
                "400",
            ),
            (format!("GET {good} HTTP/1.1\r\nHost: 127.0.0.1"), "400"),
            (
                format!("GET {good} HTTP/1.1\r\nHost: 127.0.0.1:{}", port + 1),
                "400",
            ),
            (format!("GET {good} HTTP/1.1\r\nHost: evil.test"), "400"),
            (format!("GET {good} HTTP/1.1"), "400"),
            (
                format!("GET {good} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nHost: evil.test"),
                "400",
            ),
            (
                format!("POST {good} HTTP/1.1\r\nHost: 127.0.0.1:{port}"),
                "400",
            ),
            (
                format!("HEAD {good} HTTP/1.1\r\nHost: 127.0.0.1:{port}"),
                "400",
            ),
            (
                format!("GET {good} HTTP/2\r\nHost: 127.0.0.1:{port}"),
                "400",
            ),
            (
                format!("GET http://127.0.0.1:{port}{good} HTTP/1.1\r\nHost: 127.0.0.1:{port}"),
                "404",
            ),
            (
                format!("GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1:{port}"),
                "404",
            ),
            (
                format!("GET /cb{good} HTTP/1.1\r\nHost: 127.0.0.1:{port}"),
                "404",
            ),
            (
                format!("GET //{good} HTTP/1.1\r\nHost: 127.0.0.1:{port}"),
                "404",
            ),
            ("garbage".to_owned(), "400"),
        ] {
            let r = send(port, &head);
            assert!(
                status(&r).starts_with(&format!("HTTP/1.1 {want}")),
                "{head}: {r:?}"
            );
        }
        // A head too large.
        let big = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Big: {}",
            "b".repeat(MAX_HEAD)
        );
        assert_eq!(status(&send(port, &big)), "HTTP/1.1 400 Bad Request");
        assert_eq!(o.door.read(), Reading::Waiting);
        assert_eq!(status(&get(port, &good)), "HTTP/1.1 200 OK");
        assert_eq!(o.fronts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn iss_is_passed_through_and_other_parameters_are_ignored() {
        let o = opened();
        let iss = "https://id.contentrewards.com";
        let r = get(
            o.door.port(),
            &format!(
                "/?session_state=xyz&code=abc&state={STATE}&iss={}&utm=1",
                enc(iss)
            ),
        );
        assert_eq!(status(&r), "HTTP/1.1 200 OK");
        assert_eq!(
            o.door.read(),
            Reading::Answered(Answer {
                state: STATE.to_owned(),
                iss: Some(iss.to_owned()),
                kind: Kind::Code("abc".to_owned()),
            })
        );
    }

    #[test]
    fn a_repeated_or_bad_part_gets_400() {
        let port = 47811;
        let ok = |q: &str| {
            parse_request(
                &format!("GET /?{q} HTTP/1.1\r\nHost: 127.0.0.1:{port}"),
                port,
            )
        };
        assert!(matches!(
            ok(&format!("code=a&state={STATE}")),
            Parsed::Answer(_)
        ));
        for q in [
            format!("code=a&code=a&state={STATE}"),
            format!("code=a&state={STATE}&state={STATE}"),
            format!("error=x&error=x&state={STATE}"),
            format!("code=a&state={STATE}&iss=a&iss=a"),
            format!("error=x&state={STATE}&error_description=a&error_description=b"),
            // both, or neither
            format!("code=a&error=x&state={STATE}"),
            format!("state={STATE}"),
            // bad characters
            format!("code=a%20b&state={STATE}"),
            format!("code=a+b&state={STATE}"),
            format!("code=&state={STATE}"),
            format!("code={}&state={STATE}", "c".repeat(check::MAX_CODE + 1)),
            format!("error=Access_Denied&state={STATE}"),
            format!("code=a&state={STATE}&iss=a%20b"),
            format!(
                "code=a&state={STATE}&iss={}",
                "i".repeat(check::MAX_ISS + 1)
            ),
            "code=a&state=a%2Fb".to_owned(),
        ] {
            assert_eq!(ok(&q), Parsed::BadRequest, "{q}");
        }
    }

    #[test]
    fn an_error_answer_gets_its_page_and_is_handed_over() {
        let o = opened();
        let r = get(
            o.door.port(),
            &format!(
                "/?error=access_denied&error_description=The%20user%0Asaid%20no&state={STATE}"
            ),
        );
        let r = r.expect("a page");
        assert!(r.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(r.contains("Content Rewards didn't connect."));
        assert!(r.contains("Go back to Clip Factory to see what to do."));
        // Nothing from the request is shown.
        assert!(!r.contains("said no"));
        assert_eq!(
            o.door.read(),
            Reading::Answered(Answer {
                state: STATE.to_owned(),
                iss: None,
                kind: Kind::Error {
                    error: "access_denied".to_owned(),
                    description: Some("The usersaid no".to_owned()),
                },
            })
        );
        assert!(soon(|| o.fronts.load(Ordering::SeqCst) == 1));
    }

    #[test]
    fn the_door_closes_after_five_minutes() {
        let o = opened();
        let port = o.door.port();
        o.clock.advance(OPEN_FOR - Duration::from_secs(1));
        assert_eq!(o.door.read(), Reading::Waiting);
        assert!(!o.door.expired());
        o.clock.advance(Duration::from_secs(1));
        assert!(o.door.expired());
        assert_eq!(o.door.read(), Reading::Expired);
        // The port closes and a late answer is never taken.
        assert!(soon(|| TcpStream::connect(("127.0.0.1", port)).is_err()));
        assert_ne!(
            status(&get(port, &format!("/?code=late&state={STATE}"))),
            "HTTP/1.1 200 OK"
        );
        assert_eq!(o.door.read(), Reading::Expired);
        assert_eq!(o.fronts.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn dropping_the_door_frees_its_port_at_once() {
        let o = opened();
        let port = o.door.port();
        drop(o.door);
        assert!(TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok());
    }

    #[test]
    fn a_silent_connection_does_not_hold_up_the_answer() {
        let clock = Arc::new(FakeClock::default());
        let mut slow = config(vec![free_port()], clock);
        slow.head_time = Duration::from_secs(4);
        let door = Door::open(&slow, Box::new(|| {})).unwrap();
        door.expect(STATE.to_owned()).unwrap();
        let _quiet = TcpStream::connect(("127.0.0.1", door.port())).unwrap();
        let started = Instant::now();
        let r = get(door.port(), &format!("/?code=abc&state={STATE}"));
        assert_eq!(status(&r), "HTTP/1.1 200 OK");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn the_pages_carry_the_safe_headers_and_nothing_else() {
        for reply in [Reply::Done, Reply::Failed] {
            let r = String::from_utf8(response(reply)).unwrap();
            let (head, body) = r.split_once("\r\n\r\n").unwrap();
            let lines: Vec<&str> = head.split("\r\n").collect();
            assert_eq!(
                lines,
                vec![
                    "HTTP/1.1 200 OK",
                    "Content-Type: text/html; charset=utf-8",
                    &format!("Content-Length: {}", body.len()),
                    "Cache-Control: no-store",
                    "Referrer-Policy: no-referrer",
                    "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'",
                    "X-Content-Type-Options: nosniff",
                    "Connection: close",
                ]
            );
            // The app's look: no pointer rule, no edges, no scripts, no outside files.
            for never in [
                "cursor:", "border:", "outline:", "<script", "src=", "href=", "url(",
            ] {
                assert!(!body.contains(never), "{never}");
            }
            assert!(body.contains("#0f372b") && body.contains("#efe7da"));
            assert!(body.contains("prefers-reduced-motion:no-preference"));
        }
        let done = String::from_utf8(response(Reply::Done)).unwrap();
        assert!(
            done.contains("<h1>Done!</h1><p>Go back to Clip Factory. You can close this tab.</p>")
        );
        let failed = String::from_utf8(response(Reply::Failed)).unwrap();
        assert!(failed.contains(
            "<h1>Content Rewards didn't connect.</h1><p>Go back to Clip Factory to see what to do.</p>"
        ));
        for (reply, first) in [
            (Reply::BadRequest, "HTTP/1.1 400 Bad Request"),
            (Reply::NotFound, "HTTP/1.1 404 Not Found"),
        ] {
            let r = String::from_utf8(response(reply)).unwrap();
            assert!(r.starts_with(&format!(
                "{first}\r\nContent-Type: text/plain; charset=utf-8\r\n"
            )));
            assert!(r.contains("\r\nCache-Control: no-store\r\n"));
            assert!(r.contains("\r\nConnection: close\r\n"));
        }
    }
}
