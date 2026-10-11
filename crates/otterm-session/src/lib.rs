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
pub use otterm_pty::{PtySize, SpawnOptions, default_shell};
use otterm_vt::diff::FrameState;
pub use otterm_vt::search::{Match, SearchOptions};
pub use otterm_vt::{CursorShape, Key, Mouse, MouseAction, MouseButton};
use otterm_vt::{Event, Terminal};

pub type SessionId = u64;

/// Most search matches returned at once.
const MAX_MATCHES: usize = 10_000;

/// Pacing of one session's frames: output within a frame is coalesced (docs/09 §3.2). A frame may
/// follow the previous one sooner only when that one ended a quiet period, so a keystroke echoed
/// right after some output is not held back, while a flood still gets at most two frames per
/// interval.
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

/// Settings for each new session's terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalOptions {
    /// Scrollback lines kept.
    pub scrollback: usize,
    /// East Asian Ambiguous characters are two cells wide.
    pub ambiguous_wide: bool,
    /// Cursor style until an application sets one.
    pub cursor_shape: CursorShape,
    pub cursor_blink: bool,
    /// Applications may turn on the Kitty keyboard protocol (decision I3).
    pub kitty_keyboard: bool,
    /// On the alternate screen the wheel sends arrow keys (decision I5).
    pub wheel_arrows: bool,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            scrollback: 10_000,
            ambiguous_wide: false,
            cursor_shape: CursorShape::Block,
            cursor_blink: true,
            kitty_keyboard: true,
            wheel_arrows: true,
        }
    }
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
    /// Scroll the view `lines` up into the scrollback (negative: down; `i32::MIN` / `i32::MAX` go
    /// to the bottom / top). On the alternate screen there is no scrollback, so the wheel sends
    /// arrow keys instead, as xterm's alternateScroll does.
    fn scroll(&self, id: SessionId, lines: i32) -> Result<()>;
    /// Report a mouse event to the application. Returns `false` if its mouse mode does not ask
    /// for it (the UI may then use it, e.g. for selection).
    fn mouse(&self, id: SessionId, mouse: &Mouse) -> Result<bool>;
    /// Text between two (line, column) positions, inclusive. Line numbers are those of the frames
    /// (`otterm_vt::Terminal::line`).
    fn text(&self, id: SessionId, start: (u64, usize), end: (u64, usize)) -> Result<String>;
    /// Find `query` in the scrollback and the screen, oldest first. An invalid regular expression
    /// is an error meant for the user.
    fn search(&self, id: SessionId, query: &str, opts: SearchOptions) -> Result<Vec<Match>>;
    /// Scroll so that `line` is in view, if it is not already.
    fn reveal(&self, id: SessionId, line: u64) -> Result<()>;
    /// Drop the scrollback.
    fn clear_scrollback(&self, id: SessionId) -> Result<()>;
    /// The pane gained or lost the keyboard; reported to the application when it asked (1004).
    fn focus(&self, id: SessionId, focused: bool) -> Result<()>;
    /// The name of a program the shell is running (for "close anyway?"), if any.
    fn running_program(&self, id: SessionId) -> Result<Option<String>>;
    /// Turn off modes a crashed program left on; the text stays.
    fn reset_modes(&self, id: SessionId) -> Result<()>;
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
    /// Line number of the top of the view while it is scrolled up; `None` follows the output.
    /// Holding a line number rather than an offset keeps the view still while output arrives.
    view_top: Mutex<Option<u64>>,
    frame: FrameSignal,
    /// The shell's process id.
    pid: Option<u32>,
}

impl Session {
    /// How far the view is scrolled up from the bottom, in lines.
    fn view_offset(&self, term: &Terminal) -> usize {
        let mut top = self.view_top.lock().unwrap();
        let Some(t) = *top else { return 0 };
        let t = t.max(term.history_base());
        let offset = term.screen_top().saturating_sub(t) as usize;
        if offset == 0 {
            *top = None;
        }
        offset
    }

    /// Go back to the live screen, e.g. when the user types.
    fn follow_output(&self) {
        if self.view_top.lock().unwrap().take().is_some() {
            self.frame.notify(false);
        }
    }

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
    options: Mutex<TerminalOptions>,
    colors: Mutex<[(u8, u8, u8); 3]>,
}

impl Default for LocalSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalSessionManager {
    /// Sessions that parse their output and send [`SessionEvent::Frame`]s.
    pub fn new() -> Self {
        Self {
            sessions: Arc::default(),
            next_id: AtomicU64::new(0),
            mode: Mode::Screen,
            options: Mutex::new(TerminalOptions::default()),
            colors: Mutex::new([(0xd8, 0xde, 0xe9), (0x1b, 0x1d, 0x23), (0x88, 0xc0, 0xd0)]),
        }
    }

    /// Sessions that send raw [`SessionEvent::Output`] instead of frames.
    pub fn raw() -> Self {
        Self { mode: Mode::Raw, ..Self::new() }
    }

    /// The theme's default colors (foreground, background, cursor) that programs ask for with
    /// OSC 10 / 11 / 12; for every session, now and later.
    pub fn set_default_colors(&self, colors: [(u8, u8, u8); 3]) {
        *self.colors.lock().unwrap() = colors;
        for session in self.sessions.lock().unwrap().values() {
            session.term.lock().unwrap().set_default_colors(colors[0], colors[1], colors[2]);
        }
    }

    /// Settings for sessions created from now on.
    pub fn set_terminal_options(&self, options: TerminalOptions) {
        *self.options.lock().unwrap() = options;
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
        let options = *self.options.lock().unwrap();
        let mut term = Terminal::new(size.cols as usize, size.rows as usize);
        term.set_scrollback_limit(options.scrollback);
        term.set_ambiguous_wide(options.ambiguous_wide);
        term.set_default_cursor(options.cursor_shape, options.cursor_blink);
        term.set_kitty_keyboard_enabled(options.kitty_keyboard);
        // Read under the colors lock that set_default_colors takes first, so a theme change
        // cannot slip between reading the colors and this session becoming visible to it.
        let colors_guard = self.colors.lock().unwrap();
        let [fg, bg, cursor] = *colors_guard;
        term.set_default_colors(fg, bg, cursor);
        let session = Arc::new(Session {
            pty: Mutex::new(Some(pty)),
            term: Mutex::new(term),
            view_top: Mutex::new(None),
            frame: FrameSignal::default(),
            pid: child.pid(),
        });
        self.sessions.lock().unwrap().insert(id, Arc::clone(&session));
        drop(colors_guard);
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
            Some(bytes) => {
                session.follow_output();
                session.with_pty(|p| p.write(&bytes)).map(|()| true)
            }
            None => Ok(false),
        }
    }

    fn paste(&self, id: SessionId, text: &str) -> Result<()> {
        let session = self.get(id)?;
        let modes = session.term.lock().unwrap().modes();
        let bytes = otterm_vt::encode_paste(text, &modes);
        session.follow_output();
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

    fn scroll(&self, id: SessionId, lines: i32) -> Result<()> {
        let session = self.get(id)?;
        let term = session.term.lock().unwrap();
        let modes = term.modes();
        if modes.alt_screen {
            drop(term);
            // Read now, so a config change applies to open panes too.
            if !self.options.lock().unwrap().wheel_arrows {
                return Ok(());
            }
            let key = Key::new(if lines > 0 { "ArrowUp" } else { "ArrowDown" });
            let bytes = otterm_vt::encode_key(&key, &modes).expect("arrow keys have an encoding");
            return session.with_pty(|p| p.write(&bytes.repeat(lines.unsigned_abs().min(100) as usize)));
        }
        let offset = session.view_offset(&term) as i64;
        let target = (offset + lines as i64).clamp(0, term.scrollback().len() as i64) as u64;
        let top = term.screen_top() - target;
        drop(term);
        *session.view_top.lock().unwrap() = (target > 0).then_some(top);
        session.frame.notify(false);
        Ok(())
    }

    fn mouse(&self, id: SessionId, mouse: &Mouse) -> Result<bool> {
        let session = self.get(id)?;
        let modes = session.term.lock().unwrap().modes();
        match otterm_vt::encode_mouse(mouse, &modes) {
            Some(bytes) => session.with_pty(|p| p.write(&bytes)).map(|()| true),
            None => Ok(false),
        }
    }

    fn text(&self, id: SessionId, start: (u64, usize), end: (u64, usize)) -> Result<String> {
        Ok(self.get(id)?.term.lock().unwrap().text_range(start, end))
    }

    fn search(&self, id: SessionId, query: &str, opts: SearchOptions) -> Result<Vec<Match>> {
        let session = self.get(id)?;
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let re = otterm_vt::search::compile(query, opts).map_err(|e| anyhow!(e))?;
        let term = session.term.lock().unwrap();
        Ok(otterm_vt::search::search(&term, &re, MAX_MATCHES))
    }

    fn reveal(&self, id: SessionId, line: u64) -> Result<()> {
        let session = self.get(id)?;
        let term = session.term.lock().unwrap();
        let rows = term.rows() as u64;
        let offset = session.view_offset(&term) as u64;
        let top = term.screen_top() - offset;
        if (top..top + rows).contains(&line) {
            return Ok(());
        }
        // Put the line a third of the way down, so some context above it shows too.
        let wanted = line.saturating_sub(rows / 3).clamp(term.history_base(), term.screen_top());
        drop(term);
        *session.view_top.lock().unwrap() = Some(wanted);
        session.frame.notify(false);
        Ok(())
    }

    fn clear_scrollback(&self, id: SessionId) -> Result<()> {
        let session = self.get(id)?;
        session.term.lock().unwrap().clear_scrollback();
        *session.view_top.lock().unwrap() = None;
        session.frame.notify(false);
        Ok(())
    }

    fn running_program(&self, id: SessionId) -> Result<Option<String>> {
        let session = self.get(id)?;
        Ok(session.pid.and_then(child_program))
    }

    fn focus(&self, id: SessionId, focused: bool) -> Result<()> {
        let session = self.get(id)?;
        if !session.term.lock().unwrap().modes().focus_events {
            return Ok(());
        }
        session.with_pty(|p| p.write(if focused { b"\x1b[I" } else { b"\x1b[O" }))
    }

    fn reset_modes(&self, id: SessionId) -> Result<()> {
        let session = self.get(id)?;
        session.term.lock().unwrap().reset_modes();
        session.frame.notify(false);
        Ok(())
    }

    fn close(&self, id: SessionId) -> Result<()> {
        self.get(id)?.with_pty(|p| p.kill())
    }
}

/// Children of a shell that are not a program the user started: console hosts, and prompt
/// engines that some setups keep running.
const NOT_PROGRAMS: &[&str] = &["conhost", "OpenConsole", "oh-my-posh", "starship"];

/// The most recently started child process of `shell`, by name without `.exe`. Console hosts
/// (ConPTY's OpenConsole, conhost) and prompt engines are not programs the user started; nor is
/// anything younger than a second. A child with the shell's
/// own name is looked through: launchers such as scoop's shims start the real shell that way.
fn child_program(shell: u32) -> Option<String> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let stem = |p: &sysinfo::Process| {
        let n = p.name().to_string_lossy().into_owned();
        if n.to_ascii_lowercase().ends_with(".exe") { n[..n.len() - 4].to_owned() } else { n }
    };
    let mut parent = Pid::from_u32(shell);
    let mut parent_name = sys.process(parent).map(stem).unwrap_or_default();
    // Bounded: a chain of same-named launchers is short.
    for _ in 0..4 {
        let newest = sys
            .processes()
            .values()
            .filter(|p| p.parent() == Some(parent))
            // Helpers a prompt starts for a moment (git status for the prompt line) are not
            // what the user is running.
            .filter(|p| p.run_time() >= 1)
            .map(|p| (p.start_time(), stem(p), p.pid()))
            .filter(|(_, n, _)| !NOT_PROGRAMS.iter().any(|x| n.eq_ignore_ascii_case(x)))
            .max()?;
        if !newest.1.eq_ignore_ascii_case(&parent_name) {
            return Some(newest.1);
        }
        parent = newest.2;
        parent_name = newest.1;
    }
    None
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
    // Time between the last two frames; a long one means the last frame ended a quiet period.
    let mut last_gap = FRAME_INTERVAL;
    let mut last = FrameState::default();
    let mut sync_since: Option<Instant> = None;
    while session.frame.wait() {
        if last_gap < FRAME_INTERVAL {
            let wait = FRAME_INTERVAL.saturating_sub(last_frame.elapsed());
            if !wait.is_zero() {
                thread::sleep(wait);
            }
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
            let offset = session.view_offset(&term);
            otterm_vt::diff::encode_frame(&mut term, id as u32, offset, &mut last, &mut out);
        }
        if !out.is_empty() {
            last_gap = last_frame.elapsed();
            last_frame = Instant::now();
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
    fn a_program_started_by_the_shell_is_reported() {
        let mgr = LocalSessionManager::new();
        let (id, _rx) = start(&mgr);
        thread::sleep(Duration::from_millis(500));
        assert_eq!(mgr.running_program(id).unwrap(), None, "an idle shell runs nothing");
        let cmd: &[u8] = if cfg!(windows) { b"ping -n 30 127.0.0.1 > nul\r" } else { b"sleep 30\r" };
        mgr.write(id, cmd).unwrap();
        let want = if cfg!(windows) { "PING" } else { "sleep" };
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let got = mgr.running_program(id).unwrap();
            if got.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(want)) {
                break;
            }
            assert!(Instant::now() < deadline, "still {got:?}");
            thread::sleep(Duration::from_millis(100));
        }
        mgr.close(id).unwrap();
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

    /// The view offset of the next full frame (header bytes 27..31).
    fn next_offset(rx: &mpsc::Receiver<SessionEvent>) -> u32 {
        loop {
            if let SessionEvent::Frame(f) = rx.recv_timeout(Duration::from_secs(5)).expect("a frame") {
                return u32::from_le_bytes(f[27..31].try_into().unwrap());
            }
        }
    }

    #[test]
    fn scrolling_shows_history_and_typing_returns_to_the_bottom() {
        let mgr = LocalSessionManager::new();
        let (id, rx) = start(&mgr);
        mgr.resize(id, PtySize { cols: 40, rows: 5 }).unwrap();
        let lines: &[u8] = if cfg!(windows) {
            b"for /l %i in (1,1,30) do @echo n%i\r"
        } else {
            b"for i in $(seq 30); do echo n$i; done\r"
        };
        mgr.write(id, lines).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !mgr.screen_text(id).unwrap().iter().any(|l| l == "n30") {
            assert!(Instant::now() < deadline, "screen: {:?}", mgr.screen_text(id).unwrap());
            thread::sleep(Duration::from_millis(20));
        }
        thread::sleep(Duration::from_millis(100));
        while rx.try_recv().is_ok() {}

        mgr.scroll(id, 3).unwrap();
        assert_eq!(next_offset(&rx), 3);
        mgr.scroll(id, i32::MAX).unwrap();
        assert!(next_offset(&rx) > 20, "scrolled to the top of the history");
        mgr.key(id, &Key::new("x")).unwrap();
        assert_eq!(next_offset(&rx), 0, "typing follows the output again");
        mgr.close(id).unwrap();
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

/// Ctrl+C (ETX) interrupts a program in the session, also when otterm itself was started with
/// Ctrl+C ignored (otterm-pty clears that before spawning).
#[cfg(all(test, windows))]
mod ctrl_c {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn ctrl_c_stops_ping() {
        let mgr = LocalSessionManager::new();
        let (tx, rx) = mpsc::channel();
        let program = "ping.exe";
        let args = vec!["-t".into(), "127.0.0.1".into()];
        let id = mgr
            .create(
                SpawnOptions { program: Some(program.into()), args, ..Default::default() },
                Box::new(move |ev| {
                    let _ = tx.send(ev);
                }),
            )
            .unwrap();
        // Let ping start and print, so the ETX is not read before it installed its handler.
        thread::sleep(Duration::from_secs(2));
        mgr.write(id, b"\x03").unwrap();
        let t = Instant::now();
        loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                // 0xC000013A: STATUS_CONTROL_C_EXIT.
                Ok(SessionEvent::Exited { code }) => {
                    assert_eq!(code, Some(0xC000_013A));
                    break;
                }
                Ok(_) if t.elapsed() < Duration::from_secs(5) => {}
                _ => panic!("ping did not stop; screen: {:?}", mgr.screen_text(id).unwrap()),
            }
        }
    }
}
