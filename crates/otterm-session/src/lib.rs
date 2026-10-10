//! Sessions: one shell process, its PTY and its terminal state.
//!
//! [`SessionManager`] is the boundary the UI talks to. v1.0 runs sessions in-process
//! ([`LocalSessionManager`]); v1.x moves them into the `ottermd` daemon behind the same trait
//! (decision C14, docs/02-architecture.md §2.1). The VT state lives on this side of the boundary so
//! that a reattached UI can redraw from it.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use otterm_pty::{Pty, Spawned};
pub use otterm_pty::{PtySize, SpawnOptions};
pub use otterm_vt::Key;
use otterm_vt::{Event, Terminal};

pub type SessionId = u64;

/// Minimum time between two frames of one session: output within a frame is coalesced (docs/09 §3.2).
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
/// How long a frame may be held while the application has synchronized output (DECSET 2026) on.
const SYNC_TIMEOUT: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    /// Raw bytes from the PTY, in order. Only from [`LocalSessionManager::raw`].
    Output(Vec<u8>),
    /// A screen diff in the `otterm_vt::diff` format.
    Frame(Vec<u8>),
    Title(String),
    Bell,
    /// OSC 7 working directory (a `file://` URL).
    Cwd(String),
    /// OSC 52 request; the UI applies the clipboard policy (decision H2).
    ClipboardWrite(String),
    /// The process exited. Always the last event for a session. `None` if the exit code was unavailable.
    Exited {
        code: Option<u32>,
    },
}

/// Receives a session's events. Called from background threads.
pub type EventSink = Box<dyn Fn(SessionEvent) + Send + Sync>;

pub trait SessionManager: Send + Sync {
    /// Start a session. `opts.session_id` is overwritten with the new id.
    fn create(&self, opts: SpawnOptions, sink: EventSink) -> Result<SessionId>;
    fn write(&self, id: SessionId, data: &[u8]) -> Result<()>;
    /// Send a key press, encoded for the terminal's current modes. Returns `false` if the terminal
    /// has no encoding for the key.
    fn key(&self, id: SessionId, key: &Key) -> Result<bool>;
    /// Paste text, with bracketed paste when the application asked for it.
    fn paste(&self, id: SessionId, text: &str) -> Result<()>;
    fn resize(&self, id: SessionId, size: PtySize) -> Result<()>;
    /// Send the whole screen in the next frame (a UI attached or lost its state).
    fn redraw(&self, id: SessionId) -> Result<()>;
    /// Kill the process. [`SessionEvent::Exited`] follows.
    fn close(&self, id: SessionId) -> Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Parse output and send frames.
    Screen,
    /// Forward raw output (benchmarks, tests).
    Raw,
}

struct Session {
    /// `None` once the process exited: dropping the PTY closes the master, which is what ends the
    /// reader on Windows (ConPTY reports no EOF while the master is open).
    pty: Mutex<Option<Pty>>,
    term: Mutex<Terminal>,
    frame: FrameSignal,
}

impl Session {
    fn with_pty<T>(&self, f: impl FnOnce(&mut Pty) -> Result<T>) -> Result<T> {
        match self.pty.lock().unwrap().as_mut() {
            Some(pty) => f(pty),
            None => Err(anyhow!("the session has ended")),
        }
    }
}

/// Wakes the frame thread when the screen changed or the session ended.
#[derive(Default)]
struct FrameSignal {
    /// (dirty, done)
    state: Mutex<(bool, bool)>,
    cond: Condvar,
}

impl FrameSignal {
    fn notify(&self, done: bool) {
        let mut s = self.state.lock().unwrap();
        s.0 = true;
        s.1 |= done;
        self.cond.notify_one();
    }

    /// Wait for a change. Returns `false` once the session is done; a final `true` flushes the
    /// changes that came with the end.
    fn wait(&self) -> bool {
        let mut s = self.state.lock().unwrap();
        while !s.0 && !s.1 {
            s = self.cond.wait(s).unwrap();
        }
        let dirty = s.0;
        s.0 = false;
        dirty
    }
}

/// Runs every session inside the current process.
pub struct LocalSessionManager {
    sessions: Arc<Mutex<HashMap<SessionId, Arc<Session>>>>,
    next_id: AtomicU64,
    mode: Mode,
}

impl Default for LocalSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalSessionManager {
    /// Sessions that parse their output and send [`SessionEvent::Frame`]s.
    pub fn new() -> Self {
        Self { sessions: Arc::default(), next_id: AtomicU64::new(0), mode: Mode::Screen }
    }

    /// Sessions that send raw [`SessionEvent::Output`] instead of frames.
    pub fn raw() -> Self {
        Self { mode: Mode::Raw, ..Self::new() }
    }

    fn get(&self, id: SessionId) -> Result<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned().ok_or_else(|| anyhow!("no session {id}"))
    }

    /// The visible text of a session's screen (tests, accessibility).
    pub fn screen_text(&self, id: SessionId) -> Result<Vec<String>> {
        Ok(self.get(id)?.term.lock().unwrap().screen_text())
    }
}

impl SessionManager for LocalSessionManager {
    fn create(&self, mut opts: SpawnOptions, sink: EventSink) -> Result<SessionId> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        opts.session_id = id.to_string();
        let size = opts.size;
        let Spawned { pty, mut reader, child } = Pty::spawn(opts)?;
        let session = Arc::new(Session {
            pty: Mutex::new(Some(pty)),
            term: Mutex::new(Terminal::new(size.cols as usize, size.rows as usize)),
            frame: FrameSignal::default(),
        });
        self.sessions.lock().unwrap().insert(id, Arc::clone(&session));
        let sink: Arc<EventSink> = Arc::new(sink);
        let mode = self.mode;

        // Waiter: when the child exits, forget the session and close its PTY.
        let sessions = Arc::clone(&self.sessions);
        let closing = Arc::clone(&session);
        let waiter = thread::Builder::new().name(format!("session-{id}-wait")).spawn(move || {
            let code = child.wait().ok();
            sessions.lock().unwrap().remove(&id);
            closing.pty.lock().unwrap().take();
            code
        })?;

        let framer = match mode {
            Mode::Screen => {
                let session = Arc::clone(&session);
                let sink = Arc::clone(&sink);
                Some(
                    thread::Builder::new()
                        .name(format!("session-{id}-frame"))
                        .spawn(move || frame_loop(id, &session, &sink))?,
                )
            }
            Mode::Raw => None,
        };

        // Reader: parse or forward output. `Exited` goes out after the stream ended and the last
        // frame was sent, so it is always the last event.
        thread::Builder::new().name(format!("session-{id}-read")).spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                match mode {
                    Mode::Raw => sink(SessionEvent::Output(buf[..n].to_vec())),
                    Mode::Screen => apply_output(&session, &sink, &buf[..n]),
                }
            }
            session.frame.notify(true);
            if let Some(framer) = framer {
                let _ = framer.join();
            }
            let code = waiter.join().ok().flatten();
            sink(SessionEvent::Exited { code });
        })?;

        Ok(id)
    }

    fn write(&self, id: SessionId, data: &[u8]) -> Result<()> {
        self.get(id)?.with_pty(|p| p.write(data))
    }

    fn key(&self, id: SessionId, key: &Key) -> Result<bool> {
        let session = self.get(id)?;
        let modes = session.term.lock().unwrap().modes();
        match otterm_vt::encode_key(key, &modes) {
            Some(bytes) => session.with_pty(|p| p.write(&bytes)).map(|()| true),
            None => Ok(false),
        }
    }

    fn paste(&self, id: SessionId, text: &str) -> Result<()> {
        let session = self.get(id)?;
        let modes = session.term.lock().unwrap().modes();
        let bytes = otterm_vt::encode_paste(text, &modes);
        session.with_pty(|p| p.write(&bytes))
    }

    fn resize(&self, id: SessionId, size: PtySize) -> Result<()> {
        let session = self.get(id)?;
        session.term.lock().unwrap().resize(size.cols as usize, size.rows as usize);
        session.with_pty(|p| p.resize(size))?;
        session.frame.notify(false);
        Ok(())
    }

    fn redraw(&self, id: SessionId) -> Result<()> {
        let session = self.get(id)?;
        session.term.lock().unwrap().mark_full_damage();
        session.frame.notify(false);
        Ok(())
    }

    fn close(&self, id: SessionId) -> Result<()> {
        self.get(id)?.with_pty(|p| p.kill())
    }
}

/// Feed output to the terminal, answer its queries and forward its events.
fn apply_output(session: &Session, sink: &EventSink, bytes: &[u8]) {
    let (responses, events) = {
        let mut term = session.term.lock().unwrap();
        term.advance(bytes);
        (term.take_responses(), term.take_events())
    };
    // Answers to DSR / DA queries. ConPTY sends nothing until its cursor position query is answered.
    if !responses.is_empty() {
        let _ = session.with_pty(|p| p.write(&responses));
    }
    for ev in events {
        sink(match ev {
            Event::Bell => SessionEvent::Bell,
            Event::Title(t) => SessionEvent::Title(t),
            Event::Cwd(c) => SessionEvent::Cwd(c),
            Event::ClipboardWrite(d) => SessionEvent::ClipboardWrite(d),
        });
    }
    session.frame.notify(false);
}

/// Turn screen changes into at most one frame per [`FRAME_INTERVAL`].
fn frame_loop(id: SessionId, session: &Session, sink: &EventSink) {
    let mut last_frame = Instant::now() - FRAME_INTERVAL;
    let mut last_cursor = None;
    let mut sync_since: Option<Instant> = None;
    while session.frame.wait() {
        let wait = FRAME_INTERVAL.saturating_sub(last_frame.elapsed());
        if !wait.is_zero() {
            thread::sleep(wait);
        }
        let mut out = Vec::new();
        {
            let mut term = session.term.lock().unwrap();
            // Hold the frame while the application draws one (synchronized output), up to a limit.
            if term.modes().synchronized_output {
                let since = *sync_since.get_or_insert_with(Instant::now);
                if since.elapsed() < SYNC_TIMEOUT {
                    drop(term);
                    session.frame.notify(false);
                    thread::sleep(FRAME_INTERVAL);
                    continue;
                }
            }
            sync_since = None;
            otterm_vt::diff::encode_frame(&mut term, id as u32, &mut last_cursor, &mut out);
        }
        last_frame = Instant::now();
        if !out.is_empty() {
            sink(SessionEvent::Frame(out));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn shell() -> (String, Vec<String>) {
        if cfg!(windows) { ("cmd.exe".into(), vec!["/q".into()]) } else { ("/bin/sh".into(), vec![]) }
    }

    fn start(mgr: &LocalSessionManager) -> (SessionId, mpsc::Receiver<SessionEvent>) {
        let (tx, rx) = mpsc::channel();
        let (program, args) = shell();
        let id = mgr
            .create(
                SpawnOptions { program: Some(program), args, ..Default::default() },
                Box::new(move |ev| {
                    let _ = tx.send(ev);
                }),
            )
            .unwrap();
        (id, rx)
    }

    // Only the expanded variable proves the shell ran the line; the echoed input still reads `$OTTERM`.
    const ECHO: &[u8] = if cfg!(windows) { b"echo otterm-%OTTERM%\r" } else { b"echo otterm-$OTTERM\r" };

    #[test]
    fn screen_mode_parses_output_answers_queries_and_sends_frames() {
        let mgr = LocalSessionManager::new();
        let (id, rx) = start(&mgr);
        mgr.write(id, ECHO).unwrap();

        // No manual DSR answer here: the session replies itself, or ConPTY would print nothing.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !mgr.screen_text(id).unwrap().iter().any(|l| l.contains("otterm-1")) {
            assert!(Instant::now() < deadline, "screen: {:?}", mgr.screen_text(id).unwrap());
            thread::sleep(Duration::from_millis(20));
        }
        mgr.write(id, b"exit\r").unwrap();

        let mut frames = 0;
        let code = loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("session did not exit within 10 s") {
                SessionEvent::Frame(f) => {
                    assert_eq!(f[0], otterm_vt::diff::FRAME);
                    frames += 1;
                }
                SessionEvent::Output(_) => panic!("screen mode sends frames, not raw output"),
                SessionEvent::Exited { code } => break code,
                _ => {}
            }
        };
        assert!(frames > 0);
        assert_eq!(code, Some(0));
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "no events after Exited");
        assert!(mgr.write(id, b"x").is_err(), "session is removed after exit");
    }

    #[test]
    fn raw_mode_forwards_output_and_exit_is_the_last_event() {
        let mgr = LocalSessionManager::raw();
        let (id, rx) = start(&mgr);
        mgr.write(id, ECHO).unwrap();
        mgr.write(id, b"exit\r").unwrap();

        let mut out = Vec::new();
        let code = loop {
            match rx.recv_timeout(Duration::from_secs(10)).expect("session did not exit within 10 s") {
                SessionEvent::Output(bytes) => {
                    // Raw mode has no terminal to answer ConPTY's cursor position query.
                    if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                        mgr.write(id, b"\x1b[1;1R").unwrap();
                    }
                    out.extend(bytes);
                }
                SessionEvent::Exited { code } => break code,
                other => panic!("unexpected {other:?}"),
            }
        };
        assert!(String::from_utf8_lossy(&out).contains("otterm-1"), "output: {:?}", String::from_utf8_lossy(&out));
        assert_eq!(code, Some(0));
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "no events after Exited");
    }

    #[test]
    fn close_kills_the_process_and_reports_exit() {
        let mgr = LocalSessionManager::new();
        let (id, rx) = start(&mgr);
        mgr.close(id).expect("close succeeds");
        loop {
            if let SessionEvent::Exited { .. } =
                rx.recv_timeout(Duration::from_secs(10)).expect("no Exited within 10 s after close")
            {
                break;
            }
        }
    }

    #[test]
    fn resize_changes_the_screen_and_redraw_sends_everything() {
        let mgr = LocalSessionManager::new();
        let (id, rx) = start(&mgr);
        mgr.resize(id, PtySize { cols: 50, rows: 7 }).unwrap();
        assert_eq!(mgr.screen_text(id).unwrap().len(), 7);
        while rx.recv_timeout(Duration::from_millis(300)).is_ok() {}
        mgr.redraw(id).unwrap();
        match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
            SessionEvent::Frame(f) => assert_eq!(f[14] & 1, 1, "full frame"),
            other => panic!("expected a frame, got {other:?}"),
        }
        mgr.close(id).unwrap();
    }
}
