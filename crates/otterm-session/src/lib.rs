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
use otterm_vt::diff::{FrameState, View};
pub use otterm_vt::search::{Match, SearchOptions};
pub use otterm_vt::{BlockState, CursorShape, Key, Mouse, MouseAction, MouseButton};
use otterm_vt::{Event, Terminal};

pub mod remote;

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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
    /// A command of the shell integration started (OSC 133 C); `command` may be empty. `line` is
    /// the block's head row, for [`SessionManager::block`].
    BlockStart {
        line: u64,
        command: String,
    },
    /// That command ended (OSC 133 D). `command` is its line, for the history (decision K1).
    BlockEnd {
        line: u64,
        command: String,
        exit: i32,
        ms: u32,
    },
    /// The line being typed at the prompt changed (docs/02 §6, estimated from the screen between
    /// OSC 133 B and the cursor). An empty line with `active: false` means input ended.
    Input {
        line: String,
        cursor: usize,
        active: bool,
        /// The shell reported the line (method A) rather than otterm reading the screen.
        exact: bool,
    },
    /// The terminal's echo went off or on (a password prompt, decision K2). While it is off the
    /// input assist stops and nothing typed is recorded.
    EchoOff(bool),
    /// The process exited. Always the last event for a session. `None` if the exit code was unavailable.
    Exited {
        code: Option<u32>,
    },
}

/// A block head without its output.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BlockSummary {
    pub line: u64,
    pub command: Option<String>,
    pub state: BlockState,
}

/// A block of the shell integration (docs/03 §6.3), as the block menu needs it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BlockText {
    /// Line number of the head row.
    pub line: u64,
    /// Line number of its last row.
    pub end: u64,
    pub command: Option<String>,
    pub state: BlockState,
    /// The prompt bar's info (base64 JSON), empty when the shell printed its own prompt.
    pub info: String,
    /// The command's output so far, without trailing blank lines.
    pub output: String,
    /// The output has enough rows to fold (two or more).
    pub foldable: bool,
    /// Some of its output is folded away.
    pub folded: bool,
}

/// Lines of a block hidden from the view (docs/03 §6.3). The row before `start` stands in for
/// them and shows how many there are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fold {
    /// Line of the block head the fold belongs to.
    pub head: u64,
    /// First and last hidden line, inclusive.
    pub start: u64,
    pub end: u64,
}

/// Which lines a session shows: see [`Session::view`].
struct ViewData {
    /// The line of each row (`u64::MAX` for blank rows below the last line).
    lines: Vec<u64>,
    /// Every line that is not folded away, oldest first; empty when nothing is folded (then
    /// visible line `i` is `history_base + i`).
    visible: Vec<u64>,
    /// Lines above the live view; the index of the live view's first line in `visible`.
    scrollback: usize,
    offset: usize,
    folds: Vec<(u64, u32)>,
}

/// Settings for each new session's terminal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TerminalOptions {
    /// Scrollback lines kept; `usize::MAX` is unlimited, with old chunks spilled to disk.
    pub scrollback: usize,
    /// Disk the spilled chunks of one session may take, in MB (`terminal.scrollback_spill_limit_mb`).
    pub spill_limit_mb: u64,
    /// East Asian Ambiguous characters are two cells wide.
    pub ambiguous_wide: bool,
    /// Cursor style until an application sets one.
    pub cursor_shape: CursorShape,
    pub cursor_blink: bool,
    /// Applications may turn on the Kitty keyboard protocol (decision I3).
    pub kitty_keyboard: bool,
    /// On the alternate screen the wheel sends arrow keys (decision I5).
    pub wheel_arrows: bool,
    /// Output longer than this many rows is folded in the middle when its command ends (docs/03
    /// §6.3); 0 turns that off.
    pub fold_lines: usize,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        Self {
            scrollback: 10_000,
            spill_limit_mb: 1024,
            ambiguous_wide: false,
            cursor_shape: CursorShape::Block,
            cursor_blink: true,
            kitty_keyboard: true,
            wheel_arrows: true,
            fold_lines: 200,
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
    /// `trim` drops the blanks at the end of each line.
    fn text(&self, id: SessionId, start: (u64, usize), end: (u64, usize), trim: bool) -> Result<String>;
    /// Find `query` in the scrollback and the screen, oldest first. An invalid regular expression
    /// is an error meant for the user.
    fn search(&self, id: SessionId, query: &str, opts: SearchOptions) -> Result<Vec<Match>>;
    /// Scroll so that `line` is in view, if it is not already.
    fn reveal(&self, id: SessionId, line: u64) -> Result<()>;
    /// The block (docs/03 §6.3) that holds `line`, a line number of the frames.
    fn block(&self, id: SessionId, line: u64) -> Result<Option<BlockText>>;
    /// Scroll so that the previous (`dir < 0`) or next block head is at the top of the view.
    /// `false` when there is none that way, or it is in view already.
    fn block_jump(&self, id: SessionId, dir: i32) -> Result<bool>;
    /// Every block (docs/03 §6.3) still in the scrollback or on the screen, oldest first, without
    /// its output: for the palette's `#` search and `ctx.terminal.blocks`.
    fn blocks(&self, id: SessionId) -> Result<Vec<BlockSummary>>;
    /// The visible screen as text, one string per row, and the cursor (`ctx.terminal.screen`).
    fn screen_and_cursor(&self, id: SessionId) -> Result<(Vec<String>, (usize, usize))>;
    /// Scroll so that row `n` (1-based) of the scrollback and screen together is in view: the
    /// palette's `:` jump.
    fn reveal_row(&self, id: SessionId, n: u64) -> Result<()>;
    /// Fold (`Some(true)`), show (`Some(false)`) or toggle (`None`) the output of the block
    /// holding `line`, or of the newest finished block when `line` is `None`. Returns whether the
    /// block is folded afterwards; `None` when there is no such block or nothing to fold.
    fn block_fold(&self, id: SessionId, line: Option<u64>, fold: Option<bool>) -> Result<Option<bool>>;
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

    /// The theme's default colors (foreground, background, cursor) that programs ask for with
    /// OSC 10 / 11 / 12; for every session, now and later.
    fn set_default_colors(&self, colors: [(u8, u8, u8); 3]);
    /// Settings for sessions created from now on.
    fn set_terminal_options(&self, options: TerminalOptions);
    /// Where sessions with unlimited scrollback keep their spilled chunks, one folder each.
    fn set_spill_root(&self, root: Option<std::path::PathBuf>);
    /// Lines in each session's scrollback, for the memory warning (decision I13).
    fn scrollback_lines(&self) -> Vec<(SessionId, usize)>;

    /// Sessions that outlived the window that ran them and wait for a window to pick them up
    /// (decision M26). Only the session daemon keeps such sessions.
    fn detached(&self) -> Vec<DetachedSession> {
        Vec::new()
    }
    /// Take over a detached session: its events go to `sink` from now on, starting with a full
    /// frame and its title and folder.
    fn attach(&self, id: SessionId, sink: EventSink) -> Result<()> {
        let _ = sink;
        Err(anyhow!("session {id} cannot be attached: sessions run inside this window"))
    }
    /// The window is going away. `close` ends its sessions (a normal quit); otherwise they stay
    /// with the daemon for the next window (a restart for an update, or `keep_sessions`).
    fn release(&self, close: bool) {
        let _ = close;
    }
}

/// A session the daemon keeps without a window (decision M26).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DetachedSession {
    pub id: SessionId,
    /// The program it runs, as started.
    pub program: String,
    pub title: String,
    /// The last OSC 7 folder (a `file://` URL), if the shell reported one.
    pub cwd: Option<String>,
    /// When it started, in milliseconds since the Unix epoch: windows restore tabs in this order.
    pub started_ms: u64,
    /// The exit code once the process ended while no window was attached.
    pub exited: Option<Option<u32>>,
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
    /// Folded block output (docs/03 §6.3), ascending by line, never overlapping.
    folds: Mutex<Vec<Fold>>,
    /// `TerminalOptions::fold_lines` when the session started.
    fold_lines: usize,
    frame: FrameSignal,
    /// The shell's process id.
    pid: Option<u32>,
}

impl Session {
    /// The lines the view shows now: the scroll position applied to the lines that are not
    /// folded away. Folds that fell out of the scrollback are dropped here.
    fn view(&self, term: &Terminal) -> ViewData {
        let rows = term.rows();
        let base = term.history_base();
        let screen_top = term.screen_top();
        let mut folds = self.folds.lock().unwrap();
        folds.retain(|f| f.end >= base);
        let mut top = self.view_top.lock().unwrap();
        if folds.is_empty() || term.modes().alt_screen {
            let scrollback = term.scrollback_len();
            let mut offset = 0;
            if let Some(t) = *top {
                offset = screen_top.saturating_sub(t.max(base)) as usize;
                if offset == 0 {
                    *top = None;
                }
            }
            let first = screen_top - offset as u64;
            let lines = (first..first + rows as u64).collect();
            return ViewData { lines, visible: Vec::new(), scrollback, offset, folds: Vec::new() };
        }
        let last = screen_top + rows as u64 - 1;
        let mut visible: Vec<u64> = Vec::with_capacity((last - base + 1) as usize);
        let mut stand_ins: Vec<(u64, u32)> = Vec::new();
        let mut line = base;
        for f in folds.iter() {
            let (start, end) = (f.start.max(base), f.end.min(last));
            if start > end || start <= line {
                continue;
            }
            visible.extend(line..start);
            stand_ins.push((start - 1, (end - start + 1) as u32));
            line = end + 1;
        }
        visible.extend(line..=last);
        let total = visible.len();
        let bottom = total.saturating_sub(rows);
        let index = match *top {
            Some(t) => {
                let i = visible.partition_point(|&l| l < t).min(bottom);
                if i == bottom {
                    *top = None;
                }
                i
            }
            None => bottom,
        };
        let mut lines: Vec<u64> = visible[index..(index + rows).min(total)].to_vec();
        lines.resize(rows, u64::MAX);
        let in_view = stand_ins.into_iter().filter(|(l, _)| lines.contains(l)).collect();
        ViewData { lines, visible, scrollback: bottom, offset: bottom - index, folds: in_view }
    }

    /// Scroll so that the view starts at visible line `index` (of `view`); the bottom follows
    /// the output again.
    fn scroll_to_index(&self, view: &ViewData, term: &Terminal, index: usize) {
        let index = index.min(view.scrollback);
        let line = if view.visible.is_empty() { term.history_base() + index as u64 } else { view.visible[index] };
        *self.view_top.lock().unwrap() = (index < view.scrollback).then_some(line);
        self.frame.notify(false);
    }

    /// Where `line` is among the visible lines of `view`, or where it would be.
    fn index_of(view: &ViewData, term: &Terminal, line: u64) -> usize {
        if view.visible.is_empty() {
            line.saturating_sub(term.history_base()) as usize
        } else {
            view.visible.partition_point(|&l| l < line)
        }
    }

    /// The output rows of the block at `range`: its first line and its last non-blank line.
    fn output_rows(term: &Terminal, range: &otterm_vt::BlockRange) -> Option<(u64, u64)> {
        let head = range.head;
        if matches!(head.state, BlockState::Prompt | BlockState::Input) {
            return None;
        }
        let from = head.output_line.unwrap_or(range.line + if head.has_bar() { 2 } else { 1 });
        let mut end = range.end;
        while end > from && term.line(end).is_none_or(|r| r.text().is_empty()) {
            end -= 1;
        }
        (from <= end).then_some((from, end))
    }

    /// Fold the middle of a block's output when it is longer than `fold_lines` rows.
    fn fold_long_output(&self, head: u64) {
        if self.fold_lines == 0 {
            return;
        }
        let term = self.term.lock().unwrap();
        let Some(range) = term.block_at(head) else { return };
        let Some((from, end)) = Self::output_rows(&term, &range) else { return };
        let rows = (end - from + 1) as usize;
        if rows <= self.fold_lines {
            return;
        }
        // Keep half the limit at each end, so what is shown still reads as the start and the end.
        let keep = (self.fold_lines / 2).max(1) as u64;
        let fold = Fold { head: range.line, start: from + keep, end: end - keep };
        if fold.start > fold.end {
            return;
        }
        let mut folds = self.folds.lock().unwrap();
        folds.retain(|f| f.head != fold.head);
        folds.push(fold);
        folds.sort_by_key(|f| f.start);
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
    spill_root: Mutex<Option<std::path::PathBuf>>,
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
            spill_root: Mutex::new(None),
        }
    }

    /// Sessions whose ids start after `base`, so that ids from several daemons never meet in one
    /// window (decision M26). Frames carry ids as u32, so `base` plus the sessions must fit in one.
    pub fn with_id_base(base: u64) -> Self {
        Self { next_id: AtomicU64::new(base), ..Self::new() }
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

    /// Where sessions with unlimited scrollback keep their spilled chunks, one folder each.
    pub fn set_spill_root(&self, root: Option<std::path::PathBuf>) {
        *self.spill_root.lock().unwrap() = root;
    }

    fn get(&self, id: SessionId) -> Result<Arc<Session>> {
        self.sessions.lock().unwrap().get(&id).cloned().ok_or_else(|| anyhow!("no session {id}"))
    }

    /// The visible text of a session's screen (tests, accessibility).
    pub fn screen_text(&self, id: SessionId) -> Result<Vec<String>> {
        Ok(self.get(id)?.term.lock().unwrap().screen_text())
    }

    /// Lines in each session's scrollback, for the memory warning (decision I13).
    pub fn scrollback_lines(&self) -> Vec<(SessionId, usize)> {
        // The sessions map is not held while the terminals are locked.
        let list: Vec<(SessionId, Arc<Session>)> =
            self.sessions.lock().unwrap().iter().map(|(id, s)| (*id, Arc::clone(s))).collect();
        list.into_iter().map(|(id, s)| (id, s.term.lock().unwrap().scrollback_len())).collect()
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
        if options.scrollback == usize::MAX
            && let Some(root) = self.spill_root.lock().unwrap().clone()
        {
            term.set_scrollback_spill(Some(otterm_vt::Spill {
                dir: root.join(id.to_string()),
                limit_bytes: options.spill_limit_mb.saturating_mul(1024 * 1024),
            }));
        }
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
            folds: Mutex::new(Vec::new()),
            fold_lines: options.fold_lines,
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
        let view = session.view(&term);
        let index = (view.scrollback - view.offset) as i64 - lines as i64;
        session.scroll_to_index(&view, &term, index.clamp(0, view.scrollback as i64) as usize);
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

    fn text(&self, id: SessionId, start: (u64, usize), end: (u64, usize), trim: bool) -> Result<String> {
        Ok(self.get(id)?.term.lock().unwrap().text_range_trim(start, end, trim))
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
        // A line folded away (a search hit inside a fold) is shown again first.
        session.folds.lock().unwrap().retain(|f| !(f.start..=f.end).contains(&line));
        let view = session.view(&term);
        if view.lines.contains(&line) {
            session.frame.notify(false);
            return Ok(());
        }
        // Put the line a third of the way down, so some context above it shows too.
        let index = Session::index_of(&view, &term, line).saturating_sub(term.rows() / 3);
        session.scroll_to_index(&view, &term, index);
        Ok(())
    }

    fn block(&self, id: SessionId, line: u64) -> Result<Option<BlockText>> {
        let session = self.get(id)?;
        let term = session.term.lock().unwrap();
        let Some(range) = term.block_at(line) else { return Ok(None) };
        let head = range.head;
        let rows = Session::output_rows(&term, &range);
        let output = match rows {
            Some((from, end)) => {
                let text = term.text_range((from, 0), (end, term.cols().saturating_sub(1)));
                text.trim_end_matches(['\n', ' ']).to_owned()
            }
            None => String::new(),
        };
        let folded = session.folds.lock().unwrap().iter().any(|f| f.head == range.line);
        Ok(Some(BlockText {
            line: range.line,
            end: range.end,
            command: head.command.as_deref().map(str::to_owned),
            state: head.state,
            info: head.info.to_string(),
            output,
            foldable: rows.is_some_and(|(from, end)| end > from),
            folded,
        }))
    }

    fn block_fold(&self, id: SessionId, line: Option<u64>, fold: Option<bool>) -> Result<Option<bool>> {
        let session = self.get(id)?;
        let term = session.term.lock().unwrap();
        let cursor_line = term.screen_top() + term.cursor().row as u64;
        let range = match line {
            Some(l) => term.block_at(l),
            // The newest finished block: the one at the cursor, or the one before it when the
            // cursor's block is the prompt being typed at.
            None => term.block_at(cursor_line).and_then(|r| {
                if matches!(r.head.state, BlockState::Done { .. }) {
                    Some(r)
                } else {
                    term.block_jump(r.line, -1).and_then(|l| term.block_at(l))
                }
            }),
        };
        let Some(range) = range else { return Ok(None) };
        let Some((from, end)) = Session::output_rows(&term, &range) else { return Ok(None) };
        if end <= from {
            return Ok(None);
        }
        let mut folds = session.folds.lock().unwrap();
        let was = folds.iter().any(|f| f.head == range.line);
        let now = fold.unwrap_or(!was);
        folds.retain(|f| f.head != range.line);
        if now {
            // The first output row stays as the stand-in; the rest is hidden.
            folds.push(Fold { head: range.line, start: from + 1, end });
            folds.sort_by_key(|f| f.start);
        }
        drop(folds);
        drop(term);
        session.frame.notify(false);
        Ok(Some(now))
    }

    fn blocks(&self, id: SessionId) -> Result<Vec<BlockSummary>> {
        let session = self.get(id)?;
        let term = session.term.lock().unwrap();
        Ok(term
            .block_heads()
            .into_iter()
            .map(|(line, h)| BlockSummary { line, command: h.command.as_deref().map(str::to_owned), state: h.state })
            .collect())
    }

    fn screen_and_cursor(&self, id: SessionId) -> Result<(Vec<String>, (usize, usize))> {
        let session = self.get(id)?;
        let term = session.term.lock().unwrap();
        let top = term.screen_top();
        let last = term.cols().saturating_sub(1);
        let lines = (0..term.rows() as u64).map(|r| term.text_range((top + r, 0), (top + r, last))).collect();
        let c = term.cursor();
        Ok((lines, (c.row, c.col)))
    }

    fn reveal_row(&self, id: SessionId, n: u64) -> Result<()> {
        let line = {
            let session = self.get(id)?;
            let term = session.term.lock().unwrap();
            (term.history_base() + n.saturating_sub(1)).min(term.screen_top() + term.rows() as u64 - 1)
        };
        self.reveal(id, line)
    }

    fn block_jump(&self, id: SessionId, dir: i32) -> Result<bool> {
        let session = self.get(id)?;
        let term = session.term.lock().unwrap();
        let view = session.view(&term);
        let top = view.lines.first().copied().filter(|&l| l != u64::MAX).unwrap_or(term.screen_top());
        let Some(line) = term.block_jump(top, dir) else { return Ok(false) };
        // The view cannot go below the live screen: a head on it is in view already.
        let index = Session::index_of(&view, &term, line).min(view.scrollback);
        if index == view.scrollback - view.offset {
            return Ok(false);
        }
        session.scroll_to_index(&view, &term, index);
        Ok(true)
    }

    fn clear_scrollback(&self, id: SessionId) -> Result<()> {
        let session = self.get(id)?;
        session.term.lock().unwrap().clear_scrollback();
        session.folds.lock().unwrap().clear();
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

    // The inherent methods of the same names do the work; these make them reachable through the trait.
    fn set_default_colors(&self, colors: [(u8, u8, u8); 3]) {
        LocalSessionManager::set_default_colors(self, colors);
    }

    fn set_terminal_options(&self, options: TerminalOptions) {
        LocalSessionManager::set_terminal_options(self, options);
    }

    fn set_spill_root(&self, root: Option<std::path::PathBuf>) {
        LocalSessionManager::set_spill_root(self, root);
    }

    fn scrollback_lines(&self) -> Vec<(SessionId, usize)> {
        LocalSessionManager::scrollback_lines(self)
    }
}

/// Children of a shell that are not a program the user started: console hosts, and prompt
/// engines that some setups keep running.
const NOT_PROGRAMS: &[&str] = &["conhost", "OpenConsole", "oh-my-posh", "starship"];

/// Remove the spill folders (`<root>/<pid>`) of otterm processes that are gone: a crash leaves
/// its compressed scrollback behind, while another running window still needs its own.
pub fn clean_spill_root(root: &std::path::Path) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    for e in entries.flatten() {
        let alive = e
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
            .is_some_and(|pid| sys.process(Pid::from_u32(pid)).is_some());
        if !alive {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

/// Resident memory of this process and its child processes, in bytes (decision I13). WebView2
/// runs its browser and renderer processes as children, so they are counted too.
pub fn process_tree_memory() -> u64 {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_memory());
    let mut tree = vec![Pid::from_u32(std::process::id())];
    // Breadth first over the parent links; a scan per node is cheap at this size.
    let mut next = 0;
    while next < tree.len() {
        let parent = tree[next];
        next += 1;
        // Windows reuses process ids: a process whose parent died long ago can name an id that one
        // of ours has now. A real child never started before its parent.
        let born = sys.process(parent).map_or(0, |p| p.start_time());
        for p in sys.processes().values() {
            if p.parent() == Some(parent) && p.start_time() >= born && !tree.contains(&p.pid()) {
                tree.push(p.pid());
            }
        }
    }
    tree.iter().filter_map(|pid| sys.process(*pid)).map(|p| p.memory()).sum()
}

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
            Event::BlockStart { line, command } => SessionEvent::BlockStart { line, command },
            Event::BlockEnd { line, command, exit, ms } => {
                session.fold_long_output(line);
                SessionEvent::BlockEnd { line, command, exit, ms }
            }
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
    let mut last_input: Option<(String, usize, bool)> = None;
    let mut last_echo_off = false;
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
            let view = session.view(&term);
            let spec =
                View { lines: &view.lines, scrollback: view.scrollback, offset: view.offset, folds: &view.folds };
            otterm_vt::diff::encode_frame(&mut term, id as u32, &spec, &mut last, &mut out);
            // The input line is read from the screen, so it is checked with every frame.
            let input = term.input_line();
            if input != last_input {
                let (line, cursor, exact) = input.clone().unwrap_or_default();
                sink(SessionEvent::Input { line, cursor, active: input.is_some(), exact });
                last_input = input;
            }
            // The PTY's echo flag where there is one, else a guess from the cursor's row.
            let echo_off =
                session.pty.lock().unwrap().as_ref().and_then(Pty::echo_off).unwrap_or_else(|| term.password_prompt());
            if echo_off != last_echo_off {
                sink(SessionEvent::EchoOff(echo_off));
                last_echo_off = echo_off;
            }
        }
        if !out.is_empty() {
            last_gap = last_frame.elapsed();
            last_frame = Instant::now();
            sink(SessionEvent::Frame(out));
        }
    }
}
