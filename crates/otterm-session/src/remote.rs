//! The session daemon (decision M26): shells that outlive the window.
//!
//! `otterm --daemon` runs a [`LocalSessionManager`] in a process of its own, with no window. The
//! app talks to it through [`RemoteSessionManager`], which implements the same [`SessionManager`]
//! trait, so nothing above it changes. When the window crashes, or restarts for an update, the
//! shells keep running with their scrollback; the next window lists them with
//! [`SessionManager::detached`] and takes them back with [`SessionManager::attach`]. A normal quit
//! ends them as before ([`SessionManager::release`]).
//!
//! Transport: one TCP connection per window on 127.0.0.1, authenticated with a random token that
//! only the user's data folder holds (like the screen socket, decision M2). Every message is a
//! little-endian `u32` length, a kind byte and a payload: JSON for requests, responses and events,
//! and raw bytes for frames, which go through as `otterm_vt::diff` made them.
//!
//! Each daemon writes `<data>/daemon/<pid>.json` with its port, token and build. A window uses the
//! daemon of its own build for new sessions (an updated otterm starts a new daemon, so fixes reach
//! new shells), and still picks up the sessions an older daemon kept. A daemon with no sessions
//! and no window exits on its own.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow, bail};
use otterm_pty::{PtySize, SpawnOptions};
use otterm_vt::search::{Match, SearchOptions};
use otterm_vt::{Key, Mouse};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    BlockSummary, BlockText, DetachedSession, EventSink, LocalSessionManager, SessionEvent, SessionId, SessionManager,
    TerminalOptions,
};

/// Bumped when a message changes shape; windows and daemons of another protocol ignore each other.
pub const PROTOCOL: u32 = 1;

const HELLO: u8 = 0;
const REQUEST: u8 = 1;
const RESPONSE: u8 = 2;
const EVENT: u8 = 3;
const FRAME: u8 = 4;

/// Larger messages mean a broken peer, not a big paste.
const MAX_MESSAGE: usize = 256 << 20;
/// How long a window waits for an answer. Starting a shell is the slowest request.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// A daemon with no session and no window for this long exits.
const IDLE_EXIT: Duration = Duration::from_secs(10);
/// A daemon that no window reached after it started exits.
const FIRST_CONTACT: Duration = Duration::from_secs(30);

// --- wire --------------------------------------------------------------------------------------

fn write_message(out: &mut impl Write, kind: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(payload.len() + 5);
    buf.extend_from_slice(&(payload.len() as u32 + 1).to_le_bytes());
    buf.push(kind);
    buf.extend_from_slice(payload);
    out.write_all(&buf)
}

fn read_message(input: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut len = [0u8; 4];
    input.read_exact(&mut len)?;
    let len = u32::from_le_bytes(len) as usize;
    if len == 0 || len > MAX_MESSAGE {
        return Err(std::io::Error::other("bad message length"));
    }
    let mut buf = vec![0u8; len];
    input.read_exact(&mut buf)?;
    let kind = buf.remove(0);
    Ok((kind, buf))
}

/// What a daemon publishes in `<data>/daemon/<pid>.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub protocol: u32,
    /// Which otterm build runs it (see [`build_id`]).
    pub build: String,
}

#[derive(Serialize, Deserialize)]
struct Hello {
    token: String,
    protocol: u32,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "m", content = "a", rename_all = "snake_case")]
enum Req {
    Create { opts: SpawnOptions },
    Attach { id: SessionId },
    Detached,
    Write { id: SessionId, data: Vec<u8> },
    Key { id: SessionId, key: Key },
    Paste { id: SessionId, text: String },
    Resize { id: SessionId, size: PtySize },
    Redraw { id: SessionId },
    Scroll { id: SessionId, lines: i32 },
    Mouse { id: SessionId, mouse: Mouse },
    Text { id: SessionId, start: (u64, usize), end: (u64, usize), trim: bool },
    Search { id: SessionId, query: String, opts: SearchOptions },
    Reveal { id: SessionId, line: u64 },
    Block { id: SessionId, line: u64 },
    BlockJump { id: SessionId, dir: i32 },
    Blocks { id: SessionId },
    Screen { id: SessionId },
    RevealRow { id: SessionId, n: u64 },
    BlockFold { id: SessionId, line: Option<u64>, fold: Option<bool> },
    ClearScrollback { id: SessionId },
    Focus { id: SessionId, focused: bool },
    Running { id: SessionId },
    ResetModes { id: SessionId },
    Close { id: SessionId },
    Colors { colors: [(u8, u8, u8); 3] },
    Options { options: TerminalOptions },
    SpillRoot { root: Option<PathBuf> },
    ScrollbackLines,
    Release { close: bool },
}

#[derive(Serialize, Deserialize)]
struct Request {
    id: u64,
    req: Req,
}

#[derive(Serialize, Deserialize)]
struct Response {
    id: u64,
    #[serde(default)]
    ok: Value,
    #[serde(default)]
    err: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct EventMessage {
    session: SessionId,
    event: SessionEvent,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn new_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| anyhow!("no randomness: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Which build an executable is: its version and its size and modification time, so that a
/// rebuilt or updated otterm gets a daemon of its own.
pub fn build_id(exe: &Path) -> String {
    let meta = std::fs::metadata(exe).ok();
    let len = meta.as_ref().map_or(0, std::fs::Metadata::len);
    let modified =
        meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs());
    format!("{}-{len:x}-{modified:x}", env!("CARGO_PKG_VERSION"))
}

fn endpoint_dir(data: &Path) -> PathBuf {
    data.join("daemon")
}

/// The daemons that published an endpoint, live or not (a crashed one leaves its file).
fn endpoints(data: &Path) -> Vec<(PathBuf, Endpoint)> {
    let Ok(entries) = std::fs::read_dir(endpoint_dir(data)) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let ep: Endpoint = serde_json::from_str(&text).ok()?;
            Some((p, ep))
        })
        .filter(|(_, ep)| ep.protocol == PROTOCOL)
        .collect()
}

// --- daemon ------------------------------------------------------------------------------------

/// One window's connection, as the daemon sees it.
struct Conn {
    out: Mutex<TcpStream>,
}

impl Conn {
    /// `false` once the window is gone.
    fn send(&self, kind: u8, payload: &[u8]) -> bool {
        write_message(&mut *self.out.lock().unwrap(), kind, payload).is_ok()
    }
}

/// Where a session's events go, and what a window that attaches later needs to know.
struct Route {
    id: OnceLock<SessionId>,
    state: Mutex<RouteState>,
}

struct RouteState {
    owner: Option<Arc<Conn>>,
    program: String,
    /// `OTTERM_PROFILE` of the session, so a window that takes it back opens new tabs with it.
    profile: String,
    title: String,
    cwd: Option<String>,
    started_ms: u64,
    exited: Option<Option<u32>>,
    /// A window was told about the exit; nothing is left to hand over.
    gone: bool,
}

impl Route {
    fn deliver(&self, ev: SessionEvent) {
        // Output can come before `create` returned the id; it is set right after.
        let id = *self.id.wait();
        let owner = {
            let mut st = self.state.lock().unwrap();
            match &ev {
                SessionEvent::Title(t) => st.title.clone_from(t),
                SessionEvent::Cwd(u) => st.cwd = Some(u.clone()),
                SessionEvent::Exited { code } => st.exited = Some(*code),
                _ => {}
            }
            st.owner.clone()
        };
        let Some(conn) = owner else { return };
        let exit = matches!(ev, SessionEvent::Exited { .. });
        let ok = match ev {
            SessionEvent::Frame(bytes) => {
                let mut payload = Vec::with_capacity(bytes.len() + 8);
                payload.extend_from_slice(&id.to_le_bytes());
                payload.extend_from_slice(&bytes);
                conn.send(FRAME, &payload)
            }
            event => match serde_json::to_vec(&EventMessage { session: id, event }) {
                Ok(json) => conn.send(EVENT, &json),
                Err(_) => true,
            },
        };
        let mut st = self.state.lock().unwrap();
        if !ok {
            if st.owner.as_ref().is_some_and(|o| Arc::ptr_eq(o, &conn)) {
                st.owner = None;
            }
        } else if exit {
            st.gone = true;
        }
    }
}

struct Daemon {
    sessions: LocalSessionManager,
    routes: Mutex<HashMap<SessionId, Arc<Route>>>,
    token: String,
    windows: AtomicUsize,
    /// When the daemon last had a window or a live session.
    busy: Mutex<Instant>,
    contacted: AtomicBool,
}

/// Run the daemon until no session and no window is left. Called by `otterm --daemon`.
pub fn run_daemon(data: &Path, build: &str) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let pid = std::process::id();
    let token = new_token()?;
    // Ids from different daemons never meet in one window. Frames carry them as u32 (diff.rs), so a
    // daemon gets 65,536 ids above its own base.
    let sessions = LocalSessionManager::with_id_base(u64::from(pid & 0xFFFF) << 16);
    let spill = data.join("scrollback");
    crate::clean_spill_root(&spill);
    sessions.set_spill_root(Some(spill.join(pid.to_string())));
    let daemon = Arc::new(Daemon {
        sessions,
        routes: Mutex::default(),
        token: token.clone(),
        windows: AtomicUsize::new(0),
        busy: Mutex::new(Instant::now()),
        contacted: AtomicBool::new(false),
    });

    let dir = endpoint_dir(data);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{pid}.json"));
    let endpoint = Endpoint { port, token, pid, protocol: PROTOCOL, build: build.to_owned() };
    // Written whole and then renamed, so a window never reads half a file.
    let tmp = dir.join(format!("{pid}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&endpoint)?)?;
    std::fs::rename(&tmp, &file)?;

    {
        let daemon = Arc::clone(&daemon);
        let file = file.clone();
        thread::spawn(move || watch_idle(&daemon, &file));
    }
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let daemon = Arc::clone(&daemon);
        thread::spawn(move || serve(&daemon, stream));
    }
    let _ = std::fs::remove_file(&file);
    Ok(())
}

/// Exit once nothing needs the daemon: no window and no running shell.
fn watch_idle(daemon: &Daemon, file: &Path) {
    let started = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(500));
        daemon.routes.lock().unwrap().retain(|_, r| !r.state.lock().unwrap().gone);
        let live = daemon.routes.lock().unwrap().values().any(|r| r.state.lock().unwrap().exited.is_none());
        if live || daemon.windows.load(Ordering::SeqCst) > 0 {
            *daemon.busy.lock().unwrap() = Instant::now();
            continue;
        }
        let waited = if daemon.contacted.load(Ordering::SeqCst) { IDLE_EXIT } else { FIRST_CONTACT };
        if daemon.busy.lock().unwrap().elapsed() >= waited && started.elapsed() >= Duration::from_secs(2) {
            let _ = std::fs::remove_file(file);
            std::process::exit(0);
        }
    }
}

fn serve(daemon: &Arc<Daemon>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let Ok(mut input) = stream.try_clone() else { return };
    // The first message must be a hello with the token, within a few seconds.
    let _ = input.set_read_timeout(Some(Duration::from_secs(5)));
    let Ok((HELLO, payload)) = read_message(&mut input) else { return };
    let Ok(hello) = serde_json::from_slice::<Hello>(&payload) else { return };
    if hello.protocol != PROTOCOL || !constant_time_eq(hello.token.as_bytes(), daemon.token.as_bytes()) {
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    let _ = input.set_read_timeout(None);
    let conn = Arc::new(Conn { out: Mutex::new(stream) });
    if !conn.send(HELLO, br#"{"ok":true}"#) {
        return;
    }
    daemon.contacted.store(true, Ordering::SeqCst);
    daemon.windows.fetch_add(1, Ordering::SeqCst);
    while let Ok((kind, payload)) = read_message(&mut input) {
        if kind != REQUEST {
            continue;
        }
        let Ok(Request { id, req }) = serde_json::from_slice::<Request>(&payload) else { continue };
        let after = handle(daemon, &conn, id, req);
        if let Some(after) = after {
            after();
        }
    }
    // The window went away without saying goodbye (a crash) or after `release`: whatever it still
    // owns waits for the next one.
    for route in daemon.routes.lock().unwrap().values() {
        let mut st = route.state.lock().unwrap();
        if st.owner.as_ref().is_some_and(|o| Arc::ptr_eq(o, &conn)) {
            st.owner = None;
        }
    }
    daemon.windows.fetch_sub(1, Ordering::SeqCst);
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Run one request and answer it. Returns work to do after the answer went out: a session's events
/// must not reach the window before the id they carry.
fn handle(daemon: &Arc<Daemon>, conn: &Arc<Conn>, id: u64, req: Req) -> Option<Box<dyn FnOnce()>> {
    let s = &daemon.sessions;
    let mut after: Option<Box<dyn FnOnce()>> = None;
    let result: Result<Value> = (|| {
        Ok(match req {
            Req::Create { opts } => {
                let program = opts.program.clone().unwrap_or_else(crate::default_shell);
                let profile =
                    opts.env.iter().find(|(k, _)| k == "OTTERM_PROFILE").map(|(_, v)| v.clone()).unwrap_or_default();
                let route = Arc::new(Route {
                    id: OnceLock::new(),
                    state: Mutex::new(RouteState {
                        owner: None,
                        program,
                        profile,
                        title: String::new(),
                        cwd: None,
                        started_ms: now_ms(),
                        exited: None,
                        gone: false,
                    }),
                });
                let sink_route = Arc::clone(&route);
                let sid = s.create(opts, Box::new(move |ev| sink_route.deliver(ev)))?;
                let _ = route.id.set(sid);
                daemon.routes.lock().unwrap().insert(sid, Arc::clone(&route));
                after = Some(take_over(daemon, conn, route));
                serde_json::to_value(sid)?
            }
            Req::Attach { id: sid } => {
                let route =
                    daemon.routes.lock().unwrap().get(&sid).cloned().ok_or_else(|| anyhow!("no session {sid}"))?;
                {
                    let st = route.state.lock().unwrap();
                    if st.owner.as_ref().is_some_and(|o| !Arc::ptr_eq(o, conn)) {
                        bail!("session {sid} is open in another window");
                    }
                }
                after = Some(take_over(daemon, conn, route));
                Value::Null
            }
            Req::Detached => {
                let routes = daemon.routes.lock().unwrap();
                let mut list: Vec<DetachedSession> = routes
                    .values()
                    .filter_map(|r| {
                        let st = r.state.lock().unwrap();
                        if st.owner.is_some() || st.gone {
                            return None;
                        }
                        Some(DetachedSession {
                            id: *r.id.get()?,
                            program: st.program.clone(),
                            profile: st.profile.clone(),
                            title: st.title.clone(),
                            cwd: st.cwd.clone(),
                            started_ms: st.started_ms,
                            exited: st.exited,
                        })
                    })
                    .collect();
                list.sort_by_key(|d| (d.started_ms, d.id));
                serde_json::to_value(list)?
            }
            Req::Write { id: sid, data } => serde_json::to_value(s.write(sid, &data)?)?,
            Req::Key { id: sid, key } => serde_json::to_value(s.key(sid, &key)?)?,
            Req::Paste { id: sid, text } => serde_json::to_value(s.paste(sid, &text)?)?,
            Req::Resize { id: sid, size } => serde_json::to_value(s.resize(sid, size)?)?,
            Req::Redraw { id: sid } => serde_json::to_value(s.redraw(sid)?)?,
            Req::Scroll { id: sid, lines } => serde_json::to_value(s.scroll(sid, lines)?)?,
            Req::Mouse { id: sid, mouse } => serde_json::to_value(s.mouse(sid, &mouse)?)?,
            Req::Text { id: sid, start, end, trim } => serde_json::to_value(s.text(sid, start, end, trim)?)?,
            Req::Search { id: sid, query, opts } => serde_json::to_value(s.search(sid, &query, opts)?)?,
            Req::Reveal { id: sid, line } => serde_json::to_value(s.reveal(sid, line)?)?,
            Req::Block { id: sid, line } => serde_json::to_value(s.block(sid, line)?)?,
            Req::BlockJump { id: sid, dir } => serde_json::to_value(s.block_jump(sid, dir)?)?,
            Req::Blocks { id: sid } => serde_json::to_value(s.blocks(sid)?)?,
            Req::Screen { id: sid } => serde_json::to_value(s.screen_and_cursor(sid)?)?,
            Req::RevealRow { id: sid, n } => serde_json::to_value(s.reveal_row(sid, n)?)?,
            Req::BlockFold { id: sid, line, fold } => serde_json::to_value(s.block_fold(sid, line, fold)?)?,
            Req::ClearScrollback { id: sid } => serde_json::to_value(s.clear_scrollback(sid)?)?,
            Req::Focus { id: sid, focused } => serde_json::to_value(s.focus(sid, focused)?)?,
            Req::Running { id: sid } => serde_json::to_value(s.running_program(sid)?)?,
            Req::ResetModes { id: sid } => serde_json::to_value(s.reset_modes(sid)?)?,
            Req::Close { id: sid } => {
                // Closed on purpose: no later window should get it back.
                forget(daemon, sid);
                serde_json::to_value(s.close(sid)?)?
            }
            Req::Colors { colors } => {
                SessionManager::set_default_colors(s, colors);
                Value::Null
            }
            Req::Options { options } => {
                SessionManager::set_terminal_options(s, options);
                Value::Null
            }
            // The daemon keeps its own spill folder; a window's choice does not apply here.
            Req::SpillRoot { .. } => Value::Null,
            Req::ScrollbackLines => serde_json::to_value(SessionManager::scrollback_lines(s))?,
            Req::Release { close } => {
                let mine: Vec<SessionId> = daemon
                    .routes
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, r)| r.state.lock().unwrap().owner.as_ref().is_some_and(|o| Arc::ptr_eq(o, conn)))
                    .map(|(sid, _)| *sid)
                    .collect();
                if close {
                    for sid in mine {
                        forget(daemon, sid);
                        let _ = s.close(sid);
                    }
                }
                Value::Null
            }
        })
    })();
    let response = match result {
        Ok(ok) => Response { id, ok, err: None },
        Err(e) => {
            after = None;
            Response { id, ok: Value::Null, err: Some(e.to_string()) }
        }
    };
    if let Ok(json) = serde_json::to_vec(&response) {
        conn.send(RESPONSE, &json);
    }
    after
}

/// Leave a session out of [`Req::Detached`] from now on: the window closed it.
fn forget(daemon: &Daemon, sid: SessionId) {
    if let Some(route) = daemon.routes.lock().unwrap().get(&sid) {
        route.state.lock().unwrap().gone = true;
    }
}

/// Make `conn` the window of a session, and bring it up to date: title, folder, a full frame, or
/// the exit that happened while no window was there.
fn take_over(daemon: &Arc<Daemon>, conn: &Arc<Conn>, route: Arc<Route>) -> Box<dyn FnOnce()> {
    let daemon = Arc::clone(daemon);
    let conn = Arc::clone(conn);
    Box::new(move || {
        let Some(&sid) = route.id.get() else { return };
        let (title, cwd, exited) = {
            let mut st = route.state.lock().unwrap();
            st.owner = Some(Arc::clone(&conn));
            (st.title.clone(), st.cwd.clone(), st.exited)
        };
        let send = |event: SessionEvent| {
            if let Ok(json) = serde_json::to_vec(&EventMessage { session: sid, event }) {
                conn.send(EVENT, &json);
            }
        };
        if !title.is_empty() {
            send(SessionEvent::Title(title));
        }
        if let Some(url) = cwd {
            send(SessionEvent::Cwd(url));
        }
        match exited {
            Some(code) => {
                send(SessionEvent::Exited { code });
                daemon.routes.lock().unwrap().remove(&sid);
            }
            None => {
                let _ = daemon.sessions.redraw(sid);
            }
        }
    })
}

// --- window side -------------------------------------------------------------------------------

type Pending = (mpsc::Sender<Result<Value, String>>, Option<(SessionId, Arc<EventSink>)>);

/// One connection from this window to one daemon.
struct Link {
    out: Mutex<TcpStream>,
    next: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    sinks: Mutex<HashMap<SessionId, Arc<EventSink>>>,
    alive: AtomicBool,
    build: String,
}

impl Link {
    fn connect(ep: &Endpoint) -> Result<Arc<Link>> {
        let mut stream = TcpStream::connect_timeout(&([127, 0, 0, 1], ep.port).into(), Duration::from_secs(2))?;
        stream.set_nodelay(true)?;
        let hello = serde_json::to_vec(&Hello { token: ep.token.clone(), protocol: PROTOCOL })?;
        write_message(&mut stream, HELLO, &hello)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let (kind, _) = read_message(&mut stream)?;
        if kind != HELLO {
            bail!("the session daemon refused the connection");
        }
        stream.set_read_timeout(None)?;
        let input = stream.try_clone()?;
        let link = Arc::new(Link {
            out: Mutex::new(stream),
            next: AtomicU64::new(1),
            pending: Mutex::default(),
            sinks: Mutex::default(),
            alive: AtomicBool::new(true),
            build: ep.build.clone(),
        });
        let reader = Arc::clone(&link);
        thread::Builder::new().name("otterm-daemon-link".into()).spawn(move || reader.read_loop(input))?;
        Ok(link)
    }

    fn read_loop(&self, mut input: TcpStream) {
        while let Ok((kind, payload)) = read_message(&mut input) {
            match kind {
                RESPONSE => {
                    let Ok(r) = serde_json::from_slice::<Response>(&payload) else { continue };
                    let Some((tx, sink)) = self.pending.lock().unwrap().remove(&r.id) else { continue };
                    let result = match r.err {
                        Some(e) => Err(e),
                        None => Ok(r.ok),
                    };
                    // A new or attached session's sink is in place before its first event, which
                    // the daemon sends only after this answer. `0` stands for "the id in the answer".
                    if let (Ok(v), Some((known, sink))) = (&result, sink) {
                        let sid =
                            if known == 0 { serde_json::from_value::<SessionId>(v.clone()).ok() } else { Some(known) };
                        if let Some(sid) = sid {
                            self.sinks.lock().unwrap().insert(sid, sink);
                        }
                    }
                    let _ = tx.send(result);
                }
                FRAME if payload.len() >= 8 => {
                    let sid = u64::from_le_bytes(payload[..8].try_into().unwrap_or_default());
                    let sink = self.sinks.lock().unwrap().get(&sid).cloned();
                    if let Some(sink) = sink {
                        sink(SessionEvent::Frame(payload[8..].to_vec()));
                    }
                }
                EVENT => {
                    let Ok(m) = serde_json::from_slice::<EventMessage>(&payload) else { continue };
                    let exited = matches!(m.event, SessionEvent::Exited { .. });
                    let sink = if exited {
                        self.sinks.lock().unwrap().remove(&m.session)
                    } else {
                        self.sinks.lock().unwrap().get(&m.session).cloned()
                    };
                    if let Some(sink) = sink {
                        sink(m.event);
                    }
                }
                _ => {}
            }
        }
        // The daemon is gone, and its shells with it.
        self.alive.store(false, Ordering::SeqCst);
        for (_, (tx, _)) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err("the session daemon stopped".into()));
        }
        let sinks: Vec<Arc<EventSink>> = self.sinks.lock().unwrap().drain().map(|(_, s)| s).collect();
        for sink in sinks {
            sink(SessionEvent::Exited { code: None });
        }
    }

    fn call_with(&self, req: Req, sink: Option<(SessionId, Arc<EventSink>)>) -> Result<Value> {
        if !self.alive.load(Ordering::SeqCst) {
            bail!("the session daemon stopped");
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, (tx, sink));
        let payload = serde_json::to_vec(&Request { id, req })?;
        if let Err(e) = write_message(&mut *self.out.lock().unwrap(), REQUEST, &payload) {
            self.pending.lock().unwrap().remove(&id);
            bail!("the session daemon is unreachable: {e}");
        }
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(r) => r.map_err(|e| anyhow!(e)),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                bail!("the session daemon did not answer")
            }
        }
    }

    fn call<T: serde::de::DeserializeOwned>(&self, req: Req) -> Result<T> {
        Ok(serde_json::from_value(self.call_with(req, None)?)?)
    }
}

/// How the window finds or starts a daemon of its own build.
pub struct DaemonLauncher {
    /// The data folder, where daemons publish their endpoints.
    pub data: PathBuf,
    /// The executable to start as `<exe> --daemon`.
    pub exe: PathBuf,
    /// [`build_id`] of that executable.
    pub build: String,
}

impl DaemonLauncher {
    fn start(&self) -> Result<Arc<Link>> {
        if let Some(link) = self.find() {
            return Ok(link);
        }
        let mut cmd = std::process::Command::new(&self.exe);
        cmd.arg("--daemon")
            // The daemon may run from a copy (an update replaces the original); it still belongs to this build.
            .env("OTTERM_DAEMON_BUILD", &self.build)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        detach(&mut cmd, true);
        // Leaving the job fails when the job does not allow it; the daemon then lives in it.
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(_) => {
                detach(&mut cmd, false);
                cmd.spawn()?
            }
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(40));
            if let Some(link) = self.find() {
                return Ok(link);
            }
            if let Ok(Some(status)) = child.try_wait() {
                bail!("the session daemon exited at once ({status})");
            }
        }
        bail!("the session daemon did not start")
    }

    /// A live daemon of this build. Files of daemons that are gone are removed.
    fn find(&self) -> Option<Arc<Link>> {
        for (path, ep) in endpoints(&self.data) {
            if ep.build != self.build {
                continue;
            }
            match Link::connect(&ep) {
                Ok(link) => return Some(link),
                Err(_) => {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        None
    }
}

/// Start the daemon apart from this process: no console window, its own process group, and out
/// of any job that would end it with the window.
fn detach(cmd: &mut std::process::Command, leave_job: bool) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let job = if leave_job { CREATE_BREAKAWAY_FROM_JOB } else { 0 };
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | job);
    }
    #[cfg(unix)]
    {
        let _ = leave_job;
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

/// Sessions in a daemon, behind the [`SessionManager`] trait (decision M26).
pub struct RemoteSessionManager {
    launcher: DaemonLauncher,
    /// The daemon of this build, for new sessions; replaced when it went away.
    primary: Mutex<Arc<Link>>,
    /// Daemons of older builds that kept sessions this window took back.
    others: Mutex<Vec<Arc<Link>>>,
    /// Which daemon holds each session.
    homes: Mutex<HashMap<SessionId, Arc<Link>>>,
    /// Settings sent again to a daemon that had to be restarted.
    colors: Mutex<Option<[(u8, u8, u8); 3]>>,
    options: Mutex<Option<TerminalOptions>>,
}

impl RemoteSessionManager {
    /// Connect to the daemon of this build, starting it if needed.
    pub fn connect(launcher: DaemonLauncher) -> Result<Self> {
        let primary = launcher.start()?;
        Ok(Self {
            launcher,
            primary: Mutex::new(primary),
            others: Mutex::default(),
            homes: Mutex::default(),
            colors: Mutex::default(),
            options: Mutex::default(),
        })
    }

    /// The daemon of this build, restarted when the last one went away.
    fn primary(&self) -> Result<Arc<Link>> {
        let mut primary = self.primary.lock().unwrap();
        if !primary.alive.load(Ordering::SeqCst) {
            let link = self.launcher.start()?;
            if let Some(c) = *self.colors.lock().unwrap() {
                let _ = link.call::<Value>(Req::Colors { colors: c });
            }
            if let Some(o) = *self.options.lock().unwrap() {
                let _ = link.call::<Value>(Req::Options { options: o });
            }
            *primary = link;
        }
        Ok(Arc::clone(&primary))
    }

    fn home(&self, id: SessionId) -> Result<Arc<Link>> {
        self.homes.lock().unwrap().get(&id).cloned().ok_or_else(|| anyhow!("no session {id}"))
    }

    fn links(&self) -> Vec<Arc<Link>> {
        let primary = Arc::clone(&self.primary.lock().unwrap());
        let mut all: Vec<Arc<Link>> = Vec::new();
        if primary.alive.load(Ordering::SeqCst) {
            all.push(primary);
        }
        all.extend(self.others.lock().unwrap().iter().filter(|l| l.alive.load(Ordering::SeqCst)).cloned());
        all
    }
}

impl SessionManager for RemoteSessionManager {
    fn create(&self, opts: SpawnOptions, sink: EventSink) -> Result<SessionId> {
        let link = self.primary()?;
        let v = link.call_with(Req::Create { opts }, Some((0, Arc::new(sink))))?;
        let id: SessionId = serde_json::from_value(v)?;
        self.homes.lock().unwrap().insert(id, link);
        Ok(id)
    }
    fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        self.home(id)?.call(Req::Write { id, data: data.to_vec() })
    }
    fn key(&self, id: SessionId, key: &Key) -> Result<bool> {
        self.home(id)?.call(Req::Key { id, key: key.clone() })
    }
    fn paste(&self, id: SessionId, text: &str) -> Result<()> {
        self.home(id)?.call(Req::Paste { id, text: text.to_owned() })
    }
    fn resize(&self, id: SessionId, size: PtySize) -> Result<()> {
        self.home(id)?.call(Req::Resize { id, size })
    }
    fn redraw(&self, id: SessionId) -> Result<()> {
        self.home(id)?.call(Req::Redraw { id })
    }
    fn scroll(&self, id: SessionId, lines: i32) -> Result<()> {
        self.home(id)?.call(Req::Scroll { id, lines })
    }
    fn mouse(&self, id: SessionId, mouse: &Mouse) -> Result<bool> {
        self.home(id)?.call(Req::Mouse { id, mouse: *mouse })
    }
    fn text(&self, id: SessionId, start: (u64, usize), end: (u64, usize), trim: bool) -> Result<String> {
        self.home(id)?.call(Req::Text { id, start, end, trim })
    }
    fn search(&self, id: SessionId, query: &str, opts: SearchOptions) -> Result<Vec<Match>> {
        self.home(id)?.call(Req::Search { id, query: query.to_owned(), opts })
    }
    fn reveal(&self, id: SessionId, line: u64) -> Result<()> {
        self.home(id)?.call(Req::Reveal { id, line })
    }
    fn block(&self, id: SessionId, line: u64) -> Result<Option<BlockText>> {
        self.home(id)?.call(Req::Block { id, line })
    }
    fn block_jump(&self, id: SessionId, dir: i32) -> Result<bool> {
        self.home(id)?.call(Req::BlockJump { id, dir })
    }
    fn blocks(&self, id: SessionId) -> Result<Vec<BlockSummary>> {
        self.home(id)?.call(Req::Blocks { id })
    }
    fn screen_and_cursor(&self, id: SessionId) -> Result<(Vec<String>, (usize, usize))> {
        self.home(id)?.call(Req::Screen { id })
    }
    fn reveal_row(&self, id: SessionId, n: u64) -> Result<()> {
        self.home(id)?.call(Req::RevealRow { id, n })
    }
    fn block_fold(&self, id: SessionId, line: Option<u64>, fold: Option<bool>) -> Result<Option<bool>> {
        self.home(id)?.call(Req::BlockFold { id, line, fold })
    }
    fn clear_scrollback(&self, id: SessionId) -> Result<()> {
        self.home(id)?.call(Req::ClearScrollback { id })
    }
    fn focus(&self, id: SessionId, focused: bool) -> Result<()> {
        self.home(id)?.call(Req::Focus { id, focused })
    }
    fn running_program(&self, id: SessionId) -> Result<Option<String>> {
        self.home(id)?.call(Req::Running { id })
    }
    fn reset_modes(&self, id: SessionId) -> Result<()> {
        self.home(id)?.call(Req::ResetModes { id })
    }
    fn close(&self, id: SessionId) -> Result<()> {
        self.home(id)?.call(Req::Close { id })
    }

    fn set_default_colors(&self, colors: [(u8, u8, u8); 3]) {
        *self.colors.lock().unwrap() = Some(colors);
        for link in self.links() {
            let _ = link.call::<Value>(Req::Colors { colors });
        }
    }
    fn set_terminal_options(&self, options: TerminalOptions) {
        *self.options.lock().unwrap() = Some(options);
        if let Ok(link) = self.primary() {
            let _ = link.call::<Value>(Req::Options { options });
        }
    }
    fn set_spill_root(&self, _root: Option<PathBuf>) {}
    fn scrollback_lines(&self) -> Vec<(SessionId, usize)> {
        let mine: Vec<SessionId> = self.homes.lock().unwrap().keys().copied().collect();
        self.links()
            .iter()
            .flat_map(|l| l.call::<Vec<(SessionId, usize)>>(Req::ScrollbackLines).unwrap_or_default())
            .filter(|(id, _)| mine.contains(id))
            .collect()
    }

    fn detached(&self) -> Vec<DetachedSession> {
        // Daemons of other builds too: an update leaves the old one running with the shells.
        let known: Vec<String> = self.links().iter().map(|l| l.build.clone()).collect();
        for (path, ep) in endpoints(&self.launcher.data) {
            if known.contains(&ep.build) {
                continue;
            }
            match Link::connect(&ep) {
                Ok(link) => self.others.lock().unwrap().push(link),
                Err(_) => {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        let mut all = Vec::new();
        for link in self.links() {
            let Ok(list) = link.call::<Vec<DetachedSession>>(Req::Detached) else { continue };
            for d in list {
                self.homes.lock().unwrap().insert(d.id, Arc::clone(&link));
                all.push(d);
            }
        }
        all.sort_by_key(|d| (d.started_ms, d.id));
        all
    }

    fn attach(&self, id: SessionId, sink: EventSink) -> Result<()> {
        let link = self.home(id)?;
        link.call_with(Req::Attach { id }, Some((id, Arc::new(sink))))?;
        Ok(())
    }

    fn release(&self, close: bool) {
        for link in self.links() {
            let _ = link.call::<Value>(Req::Release { close });
            let _ = link.out.lock().unwrap().shutdown(Shutdown::Both);
        }
    }
}
