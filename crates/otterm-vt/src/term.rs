//! Terminal state machine: applies parsed VT sequences to a grid.
//! Spec: docs/03-core-features.md §2.1 (supported sequences).

use std::borrow::Cow;
use std::collections::VecDeque;

use unicode_width::UnicodeWidthChar;
use vte::{Params, Perform};

use crate::cell::{Attrs, BlockHead, BlockState, Cell, Color, Row, flags};
use crate::history::History;

/// Mouse tracking requested by the application (DECSET 1000/1002/1003).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MouseMode {
    #[default]
    Off,
    /// 1000: press and release.
    Click,
    /// 1002: also motion while a button is held.
    Drag,
    /// 1003: all motion.
    Motion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CursorShape {
    #[default]
    Block,
    Underline,
    Bar,
}

/// Modes the input encoder and renderer need to know about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Modes {
    /// DECCKM: arrow keys send `ESC O A` instead of `ESC [ A`.
    pub app_cursor: bool,
    /// DECKPAM: keypad sends application sequences.
    pub app_keypad: bool,
    pub bracketed_paste: bool,
    pub mouse: MouseMode,
    /// 1006: SGR mouse encoding.
    pub mouse_sgr: bool,
    /// 1004: report focus in / out.
    pub focus_events: bool,
    pub cursor_visible: bool,
    pub cursor_blink: bool,
    pub cursor_shape: CursorShape,
    pub alt_screen: bool,
    /// 2026: the application is mid-frame; renderers may hold the previous frame.
    pub synchronized_output: bool,
    /// Kitty keyboard protocol flags the application turned on (decision I3); 0 is xterm encoding.
    /// Only the flags in [`KITTY_SUPPORTED`] are ever set.
    pub kitty_keyboard: u8,
    autowrap: bool,
    origin: bool,
    insert: bool,
    newline: bool,
}

impl Modes {
    /// LNM: Enter sends CR LF.
    pub fn newline_mode(&self) -> bool {
        self.newline
    }
}

impl Default for Modes {
    fn default() -> Self {
        Self {
            app_cursor: false,
            app_keypad: false,
            bracketed_paste: false,
            mouse: MouseMode::Off,
            mouse_sgr: false,
            focus_events: false,
            cursor_visible: true,
            cursor_blink: true,
            cursor_shape: CursorShape::Block,
            alt_screen: false,
            synchronized_output: false,
            kitty_keyboard: 0,
            autowrap: true,
            origin: false,
            insert: false,
            newline: false,
        }
    }
}

/// Longest OSC 8 target kept; longer ones are shown as plain text.
const MAX_LINK_LEN: usize = 2048;
/// Total size of the OSC 8 targets one terminal keeps (they live as long as the session).
const MAX_LINK_BYTES: usize = 4 << 20;

/// Kitty keyboard flags otterm implements: 1 (disambiguate escape codes) and 8 (report all keys
/// as escape codes). Event types (2), alternate keys (4) and associated text (16) are not sent, and
/// the query answers with this subset so applications know.
pub const KITTY_SUPPORTED: u8 = 1 | 8;
/// Entries kept per screen; pushing more drops the oldest (as the protocol allows).
const KITTY_STACK_LIMIT: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cursor {
    pub row: usize,
    pub col: usize,
    /// The last column was written; the next printable character wraps first (DECAWM).
    pending_wrap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Charset {
    #[default]
    Ascii,
    /// DEC Special Graphics: line drawing used by tmux, htop, dialog.
    DecGraphics,
}

#[derive(Debug, Clone, Copy, Default)]
struct Saved {
    cursor: Cursor,
    pen: Attrs,
    origin: bool,
    charsets: [Charset; 2],
    active_charset: usize,
}

/// What changed since the last [`Terminal::take_damage`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Damage {
    /// Every visible row must be redrawn (resize, screen switch, full reset).
    pub full: bool,
    /// Visible rows whose content changed, ascending.
    pub rows: Vec<usize>,
}

/// Something the host has to act on that is not part of the grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Bell,
    Title(String),
    /// OSC 7: the shell reported its working directory (a `file://` URL).
    Cwd(String),
    /// OSC 52 write request. The host decides whether to allow it (decision H2).
    ClipboardWrite(String),
    /// A command of the shell integration started (OSC 133 C); `command` may be empty. `line` is
    /// its block head.
    BlockStart {
        line: u64,
        command: String,
    },
    /// That command ended with this exit code after `ms` (OSC 133 D). `line` is its block head.
    BlockEnd {
        line: u64,
        /// The command line (OSC 7777 cmd), empty when the shell did not report one.
        command: String,
        exit: i32,
        ms: u32,
    },
}

/// Where a block head is: a row of the primary screen, or an index into the scrollback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HeadAt {
    Screen(usize),
    History(usize),
}

/// A block (docs/03 §6.3): the lines from its head to the row before the next head.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockRange<'a> {
    /// Line number of the head row.
    pub line: u64,
    pub head: &'a BlockHead,
    /// Line number of the block's last row, inclusive.
    pub end: u64,
}

pub struct Terminal {
    rows: usize,
    cols: usize,
    /// Ring buffers so that scrolling the whole screen is O(1).
    primary: VecDeque<Row>,
    alt: VecDeque<Row>,
    scrollback: History,
    scrollback_limit: usize,
    /// Line number of `scrollback[0]`. Lines are numbered from the first line ever written and
    /// keep their number while they move from the screen into scrollback; see [`Self::line`].
    history_base: u64,
    cursor: Cursor,
    pen: Attrs,
    /// Saved cursor for the primary and the alternate screen (DECSC is per screen).
    saved: [Saved; 2],
    scroll_top: usize,
    scroll_bottom: usize,
    tabs: Vec<bool>,
    modes: Modes,
    charsets: [Charset; 2],
    active_charset: usize,
    /// Treat East Asian Ambiguous characters as wide (docs/03 §2.2).
    ambiguous_wide: bool,
    /// The user's cursor style, restored by DECSCUSR 0 and RIS.
    default_cursor: (CursorShape, bool),
    /// Kitty keyboard flag stacks for the primary and the alternate screen.
    kitty: [Vec<u8>; 2],
    /// The user allows the Kitty keyboard protocol (`terminal.kitty_keyboard`).
    kitty_enabled: bool,
    /// OSC 8 hyperlink targets; id `n` is `links[n - 1]`.
    links: Vec<Box<str>>,
    /// The theme's foreground, background and cursor colors, for OSC 10 / 11 / 12 queries.
    colors: [(u8, u8, u8); 3],
    link_ids: std::collections::HashMap<Box<str>, u16>,
    link_bytes: usize,
    /// Last printed character, for REP.
    last_char: Option<char>,
    dirty: Vec<bool>,
    full_damage: bool,
    responses: Vec<u8>,
    events: Vec<Event>,
    title: String,
    parser: vte::Parser,
}

impl Terminal {
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.max(1);
        let rows = rows.max(1);
        let pen = Attrs::default();
        Self {
            rows,
            cols,
            primary: (0..rows).map(|_| Row::new(cols, &pen)).collect(),
            alt: (0..rows).map(|_| Row::new(cols, &pen)).collect(),
            scrollback: History::default(),
            scrollback_limit: 10_000,
            history_base: 0,
            cursor: Cursor::default(),
            pen,
            saved: [Saved::default(); 2],
            scroll_top: 0,
            scroll_bottom: rows - 1,
            tabs: default_tabs(cols),
            modes: Modes::default(),
            charsets: [Charset::Ascii; 2],
            active_charset: 0,
            ambiguous_wide: false,
            default_cursor: (CursorShape::Block, true),
            kitty: [Vec::new(), Vec::new()],
            kitty_enabled: true,
            links: Vec::new(),
            colors: [(0xd8, 0xde, 0xe9), (0x1b, 0x1d, 0x23), (0x88, 0xc0, 0xd0)],
            link_ids: std::collections::HashMap::new(),
            link_bytes: 0,
            last_char: None,
            dirty: vec![true; rows],
            full_damage: true,
            responses: Vec::new(),
            events: Vec::new(),
            title: String::new(),
            parser: vte::Parser::new(),
        }
    }

    /// Feed PTY output.
    pub fn advance(&mut self, bytes: &[u8]) {
        let mut parser = std::mem::take(&mut self.parser);
        parser.advance(self, bytes);
        self.parser = parser;
    }

    // --- accessors -----------------------------------------------------------

    pub fn cols(&self) -> usize {
        self.cols
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    /// Visible rows, top to bottom.
    pub fn screen(&self) -> &VecDeque<Row> {
        if self.modes.alt_screen { &self.alt } else { &self.primary }
    }

    /// How many lines scrolled off the top of the primary screen are kept.
    pub fn scrollback_len(&self) -> usize {
        self.scrollback.len()
    }

    /// Keep old scrollback chunks in files under `spill.dir` past what memory holds (docs/09 §5),
    /// for unlimited scrollback (`terminal.scrollback = 0`).
    pub fn set_scrollback_spill(&mut self, spill: Option<crate::history::Spill>) {
        let dropped = self.scrollback.set_spill(spill);
        self.history_base += dropped as u64;
    }

    /// Line number of the oldest scrollback line. Screen row `r` is line `screen_top() + r`.
    pub fn history_base(&self) -> u64 {
        self.history_base
    }

    /// Line number of screen row 0.
    pub fn screen_top(&self) -> u64 {
        self.history_base + self.scrollback.len() as u64
    }

    /// A line of scrollback or of the visible screen by line number; `None` once it was dropped
    /// from scrollback, or below the screen.
    /// Old lines come back decompressed, as an owned row.
    pub fn line(&self, line: u64) -> Option<Cow<'_, Row>> {
        let i = usize::try_from(line.checked_sub(self.history_base)?).ok()?;
        match i.checked_sub(self.scrollback.len()) {
            None => self.scrollback.get(i),
            Some(r) => self.screen().get(r).map(Cow::Borrowed),
        }
    }

    /// Text from `start` to `end` inclusive, as (line, column); the order of the two does not
    /// matter. Lines end with `\n` unless they wrapped; trailing blanks are dropped.
    pub fn text_range(&self, start: (u64, usize), end: (u64, usize)) -> String {
        let (start, end) = if start <= end { (start, end) } else { (end, start) };
        let mut out = String::new();
        for line in start.0..=end.0 {
            let last = line == end.0;
            let Some(row) = self.line(line) else { continue };
            let from = if line == start.0 { start.1 } else { 0 };
            let to = if last { end.1.saturating_add(1) } else { usize::MAX };
            let mut text = String::new();
            for col in from..to.min(row.cells.len()) {
                if row.cells[col].is_spacer() {
                    continue;
                }
                text.push_str(&row.cell_text(col));
            }
            if row.wrapped && !last {
                out.push_str(&text);
            } else {
                out.push_str(text.trim_end_matches(' '));
                if !last {
                    out.push('\n');
                }
            }
        }
        out
    }

    pub fn cursor(&self) -> Cursor {
        self.cursor
    }

    pub fn modes(&self) -> Modes {
        self.modes
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn set_scrollback_limit(&mut self, lines: usize) {
        self.scrollback_limit = lines;
        self.trim_scrollback();
    }

    pub fn set_ambiguous_wide(&mut self, wide: bool) {
        self.ambiguous_wide = wide;
    }

    /// Undo what a program that crashed may have left on: the alternate screen, mouse reporting,
    /// bracketed paste, application keys, Kitty keyboard flags, a hidden cursor, a scroll region,
    /// colors. The text stays (unlike RIS). For the context menu's "reset terminal state".
    pub fn reset_modes(&mut self) {
        self.switch_screen(false, false, false);
        let (shape, blink) = self.default_cursor;
        self.modes = Modes { cursor_shape: shape, cursor_blink: blink, ..Modes::default() };
        self.kitty = [Vec::new(), Vec::new()];
        self.pen = Attrs::default();
        self.scroll_top = 0;
        self.scroll_bottom = self.rows - 1;
        self.charsets = [Charset::Ascii; 2];
        self.active_charset = 0;
        self.full_damage = true;
    }

    /// Drop the scrollback (the context menu's "clear scrollback"; ED 3 does the same).
    pub fn clear_scrollback(&mut self) {
        self.history_base += self.scrollback.len() as u64;
        self.scrollback.clear();
        self.full_damage = true;
    }

    /// The theme's default foreground, background and cursor colors, which programs ask for with
    /// OSC 10 / 11 / 12 (to pick light or dark colors of their own).
    pub fn set_default_colors(&mut self, fg: (u8, u8, u8), bg: (u8, u8, u8), cursor: (u8, u8, u8)) {
        self.colors = [fg, bg, cursor];
    }

    /// The target of an OSC 8 hyperlink id (see [`Attrs::link`]).
    pub fn link(&self, id: u16) -> Option<&str> {
        self.links.get((id as usize).checked_sub(1)?).map(|s| &**s)
    }

    /// OSC 8: start (non-empty URI) or end a hyperlink for the text printed next.
    fn set_link(&mut self, uri: &str) {
        if uri.is_empty() || uri.len() > MAX_LINK_LEN {
            self.pen.link = 0;
            return;
        }
        // The same target again (a link split over lines, or a repeated one) reuses its id.
        let id = match self.link_ids.get(uri) {
            Some(&id) => id,
            None if self.links.len() < u16::MAX as usize && self.link_bytes + uri.len() <= MAX_LINK_BYTES => {
                self.links.push(uri.into());
                self.link_bytes += uri.len();
                let id = self.links.len() as u16;
                self.link_ids.insert(uri.into(), id);
                id
            }
            // Out of ids or memory: the text is shown without its link.
            None => 0,
        };
        self.pen.link = id;
    }

    /// Whether applications may turn on the Kitty keyboard protocol. When off, its requests are
    /// ignored and its query gets no answer, so applications fall back to xterm keys.
    pub fn set_kitty_keyboard_enabled(&mut self, enabled: bool) {
        self.kitty_enabled = enabled;
        if !enabled {
            self.kitty = [Vec::new(), Vec::new()];
            self.modes.kitty_keyboard = 0;
        }
    }

    /// The cursor style used until an application asks for another (and after it asks for the
    /// default with DECSCUSR 0).
    pub fn set_default_cursor(&mut self, shape: CursorShape, blink: bool) {
        self.default_cursor = (shape, blink);
        self.modes.cursor_shape = shape;
        self.modes.cursor_blink = blink;
    }

    /// Bytes the terminal must send back to the application (DSR, DA, …). Write them to the PTY.
    pub fn take_responses(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.responses)
    }

    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }

    pub fn take_damage(&mut self) -> Damage {
        let rows = if self.full_damage {
            Vec::new()
        } else {
            self.dirty.iter().enumerate().filter(|(_, d)| **d).map(|(i, _)| i).collect()
        };
        let damage = Damage { full: self.full_damage, rows };
        self.full_damage = false;
        self.dirty.iter_mut().for_each(|d| *d = false);
        damage
    }

    /// Redraw everything in the next frame.
    pub fn mark_full_damage(&mut self) {
        self.full_damage = true;
    }

    /// Visible text, one string per row, trailing blanks removed. For tests and accessibility.
    pub fn screen_text(&self) -> Vec<String> {
        self.screen().iter().map(Row::text).collect()
    }

    // --- resize --------------------------------------------------------------

    /// Change the size. On the primary screen a new width rewraps lines (scrollback included); the
    /// alternate screen is cut or padded, since its application redraws it.
    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if cols == self.cols && rows == self.rows {
            return;
        }
        let pen = Attrs::default();

        // Primary: keep the cursor row on screen. Shrinking pushes top lines into scrollback;
        // growing pulls them back.
        let mut pending_wrap = false;
        if cols != self.cols && !self.modes.alt_screen {
            pending_wrap = self.reflow_primary(cols, rows);
        } else if rows < self.rows {
            let excess = (self.cursor.row + 1).saturating_sub(rows).min(self.rows - rows);
            let moved: Vec<Row> = self.primary.drain(..excess).collect();
            if !self.modes.alt_screen {
                for row in moved {
                    self.push_history(row);
                }
            }
            self.primary.truncate(rows);
            if !self.modes.alt_screen {
                self.cursor.row -= excess;
            }
        } else {
            let mut pulled = 0;
            while self.primary.len() < rows {
                if !self.modes.alt_screen
                    && let Some(row) = self.scrollback.pop_back()
                {
                    self.primary.push_front(row);
                    pulled += 1;
                } else {
                    self.primary.push_back(Row::new(cols, &pen));
                }
            }
            if !self.modes.alt_screen {
                self.cursor.row += pulled;
            }
        }
        self.alt.resize_with(rows, || Row::new(cols, &pen));
        for row in self.primary.iter_mut().chain(self.alt.iter_mut()) {
            row.resize(cols);
        }
        // Scrollback rows are trimmed; only cut the ones that are now too long.
        for row in self.scrollback.hot_mut().filter(|r| r.cells.len() > cols) {
            row.resize(cols);
        }
        for s in &mut self.saved {
            s.cursor.row = s.cursor.row.min(rows - 1);
            s.cursor.col = s.cursor.col.min(cols - 1);
        }

        self.cols = cols;
        self.rows = rows;
        self.cursor.row = self.cursor.row.min(rows - 1);
        self.cursor.col = self.cursor.col.min(cols - 1);
        self.cursor.pending_wrap = pending_wrap;
        self.scroll_top = 0;
        self.scroll_bottom = rows - 1;
        self.tabs = default_tabs(cols);
        self.dirty = vec![true; rows];
        self.full_damage = true;
        self.trim_scrollback();
    }

    /// Rewrap the primary screen and the recent scrollback for a new width (issue #2); compressed
    /// scrollback keeps its width (crate::history). Returns whether the cursor ends up waiting
    /// to wrap.
    fn reflow_primary(&mut self, cols: usize, rows: usize) -> bool {
        let mut all: Vec<Row> = self.scrollback.take_hot().into_iter().chain(self.primary.drain(..)).collect();
        let cursor_at = all.len() - self.rows + self.cursor.row;
        // Blank rows below the cursor hold nothing; without them the text can move down.
        while all.len() > cursor_at + 1 && all.last().is_some_and(is_blank) {
            all.pop();
        }
        let (mut out, (row, col)) = crate::reflow::reflow(all, cols, (cursor_at, self.cursor.col));
        // Show the last `rows` rows, unless that would leave the cursor above the screen.
        let start = out.len().saturating_sub(rows).min(row);
        let mut screen: VecDeque<Row> = out.drain(start..).take(rows).collect();
        screen.resize_with(rows, || Row::new(cols, &Attrs::default()));
        self.scrollback.set_hot(
            out.into_iter()
                .map(|mut r| {
                    r.compact_in_place();
                    r
                })
                .collect(),
        );
        self.primary = screen;
        self.cursor.row = row - start;
        self.cursor.col = col.min(cols - 1);
        col >= cols
    }

    // --- grid helpers ----------------------------------------------------------

    fn grid(&mut self) -> &mut VecDeque<Row> {
        if self.modes.alt_screen { &mut self.alt } else { &mut self.primary }
    }

    fn touch(&mut self, row: usize) {
        if let Some(d) = self.dirty.get_mut(row) {
            *d = true;
        }
    }

    fn touch_range(&mut self, top: usize, bottom: usize) {
        for r in top..=bottom.min(self.rows - 1) {
            self.touch(r);
        }
    }

    fn trim_scrollback(&mut self) {
        let dropped = self.scrollback.trim_to(self.scrollback_limit);
        self.history_base += dropped as u64;
    }

    /// A line leaves the top of the screen for the scrollback.
    fn push_history(&mut self, row: Row) {
        let dropped = self.scrollback.push_back(row);
        self.history_base += dropped as u64;
        if self.scrollback.len() > self.scrollback_limit {
            self.trim_scrollback();
        }
    }

    /// Clear `cols` cells of `row`, fixing up any wide character cut at either edge.
    fn erase_cells(&mut self, row: usize, from: usize, to: usize) {
        let pen = self.pen;
        let cols = self.cols;
        let to = to.min(cols);
        if from >= to {
            return;
        }
        let r = &mut self.grid()[row];
        let from = if from > 0 && r.cells[from].is_spacer() { from - 1 } else { from };
        let to = if to < cols && r.cells[to].is_spacer() { to + 1 } else { to };
        r.cells[from..to].fill(Cell::blank(&pen));
        r.clear_extra(from, to);
        // Clearing the whole row (`cls`, a redraw) takes the block head with it.
        if from == 0 && to == cols {
            r.block = None;
        }
        if pen.bg != Color::Default {
            r.touch_to(to);
        }
        self.touch(row);
    }

    // --- blocks (shell integration, docs/03 §6) -----------------------------------

    /// Line number of the cursor row.
    fn cursor_line(&self) -> u64 {
        self.screen_top() + self.cursor.row as u64
    }

    /// The newest block head at or above primary screen row `row`, looking into the scrollback
    /// when the screen has none.
    fn find_head(&self, row: usize) -> Option<HeadAt> {
        if let Some(r) = (0..=row.min(self.rows - 1)).rev().find(|&r| self.primary[r].block.is_some()) {
            return Some(HeadAt::Screen(r));
        }
        self.scrollback.last_head_before(self.scrollback.len()).map(HeadAt::History)
    }

    fn head_mut(&mut self, at: HeadAt) -> &mut BlockHead {
        match at {
            HeadAt::Screen(r) => self.primary[r].block.as_deref_mut(),
            HeadAt::History(i) => self.scrollback.head_mut(i),
        }
        .expect("a head was found there")
    }

    fn touch_head(&mut self, at: HeadAt) {
        match at {
            HeadAt::Screen(r) => self.touch(r),
            // A view scrolled up may show it.
            HeadAt::History(_) => self.full_damage = true,
        }
    }

    /// OSC 133 A: a prompt starts at the cursor. The row becomes a block head, unless it is one
    /// still at its prompt (the prompt redrawn after Ctrl+C or a resize).
    fn block_prompt_start(&mut self) {
        if self.modes.alt_screen {
            return;
        }
        let row = self.cursor.row;
        match self.primary[row].block.as_deref() {
            Some(h) if matches!(h.state, BlockState::Prompt | BlockState::Input) => {}
            _ => self.primary[row].block = Some(Box::new(BlockHead::new("".into()))),
        }
        self.touch(row);
    }

    /// OSC 7777 bar: otterm's prompt bar (decision M4) on a blank row of its own at the cursor; a
    /// new line first unless the cursor is at the start of one (output that did not end in a
    /// newline). The head OSC 133 A put where the prompt started moves onto the bar's row.
    fn block_bar(&mut self, info: String) {
        /// More than a path and a branch name need.
        const MAX_INFO: usize = 8192;
        if self.modes.alt_screen || info.is_empty() || info.len() > MAX_INFO {
            return;
        }
        let from = self.cursor.row;
        let mut head = match self.primary[from].block.take() {
            Some(h) if h.state == BlockState::Prompt => h,
            other => {
                self.primary[from].block = other;
                Box::new(BlockHead::new("".into()))
            }
        };
        if self.cursor.col > 0 || self.cursor.pending_wrap {
            self.cursor.col = 0;
            self.linefeed();
        }
        let (row, cols) = (self.cursor.row, self.cols);
        self.erase_cells(row, 0, cols);
        head.info = info.into();
        self.primary[row].block = Some(head);
        self.touch(row);
    }

    /// OSC 133 B: the prompt is printed; the user types from here.
    fn block_input_start(&mut self) {
        if self.modes.alt_screen {
            return;
        }
        let start = (self.cursor_line(), self.cursor.col);
        if let Some(at) = self.find_head(self.cursor.row) {
            let h = self.head_mut(at);
            if h.state == BlockState::Prompt {
                h.state = BlockState::Input;
                h.input_start = Some(start);
                self.touch_head(at);
            }
        }
    }

    /// The line the user is typing at the prompt, the cursor's index in it, and whether the shell
    /// reported it (method A, OSC 7777 line) rather than otterm reading it off the screen
    /// (method B: between OSC 133 B and the cursor). `None` outside of input (docs/02 §6).
    pub fn input_line(&self) -> Option<(String, usize, bool)> {
        if self.modes.alt_screen {
            return None;
        }
        let (_, head) = self.block_head_at(self.cursor_line())?;
        if head.state != BlockState::Input {
            return None;
        }
        if let Some((line, cursor)) = &head.input_exact {
            return Some((line.to_string(), *cursor, true));
        }
        let (start_line, start_col) = head.input_start?;
        let cursor_line = self.cursor_line();
        if cursor_line < start_line {
            return None;
        }
        // The line may continue past the cursor; follow soft wraps to its end.
        let mut end_line = cursor_line;
        while self.line(end_line).is_some_and(|r| r.wrapped) && self.line(end_line + 1).is_some() {
            end_line += 1;
        }
        let mut text = self.text_range((start_line, start_col), (end_line, self.cols.saturating_sub(1)));
        if (cursor_line, self.cursor.col) <= (start_line, start_col) {
            return Some((text, 0, false));
        }
        // Reading text drops trailing blanks, but a space the user typed before the cursor
        // matters (`git ` asks for a subcommand). Pad the part before the cursor back to the
        // number of cells it spans.
        let mut before = self.text_range((start_line, start_col), (cursor_line, self.cursor.col.saturating_sub(1)));
        let cells = ((cursor_line - start_line) as usize * self.cols + self.cursor.col).saturating_sub(start_col);
        let width: usize = before.chars().map(|c| c.width().unwrap_or(0)).sum();
        if width < cells {
            before.extend(std::iter::repeat_n(' ', cells - width));
        }
        let n = before.chars().count();
        if text.chars().count() < n {
            text = before;
        }
        Some((text, n, false))
    }

    /// The text of the cursor's row up to the cursor looks like a password prompt (decision K2).
    /// A guess for platforms that cannot report the PTY's echo flag (ConPTY): only while a command
    /// runs or no shell integration is active, never at otterm's own prompt.
    pub fn password_prompt(&self) -> bool {
        if self.modes.alt_screen {
            return false;
        }
        if let Some((_, head)) = self.block_head_at(self.cursor_line())
            && matches!(head.state, BlockState::Prompt | BlockState::Input)
        {
            return false;
        }
        let line = self.cursor_line();
        let text = self.text_range((line, 0), (line, self.cursor.col.saturating_sub(1)));
        let text = text.trim_end().to_lowercase();
        let Some(body) = text.strip_suffix(':').or_else(|| text.strip_suffix('：')) else { return false };
        ["password", "passphrase", "passcode", "pin", "パスワード", "暗証番号"].iter().any(|w| body.contains(w))
    }

    /// OSC 7777 line: what the line editor holds now (method A of docs/02 §6).
    fn block_input_exact(&mut self, line: String, cursor: usize) {
        if self.modes.alt_screen {
            return;
        }
        if let Some(at) = self.find_head(self.cursor.row) {
            let h = self.head_mut(at);
            if h.state == BlockState::Input {
                let cursor = cursor.min(line.chars().count());
                h.input_exact = Some((line.into_boxed_str(), cursor));
            }
        }
    }

    /// OSC 7777 cmd: the command line the user entered.
    fn block_command(&mut self, command: String) {
        /// Longer than any command line worth keeping.
        const MAX_COMMAND: usize = 1 << 16;
        if self.modes.alt_screen || command.len() > MAX_COMMAND {
            return;
        }
        if let Some(at) = self.find_head(self.cursor.row) {
            let h = self.head_mut(at);
            if matches!(h.state, BlockState::Prompt | BlockState::Input) {
                h.command = Some(command.into_boxed_str());
                self.touch_head(at);
            }
        }
    }

    /// OSC 133 C: the command runs; its output starts at the cursor.
    fn block_command_start(&mut self) {
        if self.modes.alt_screen {
            return;
        }
        let line = self.cursor_line();
        if let Some(at) = self.find_head(self.cursor.row) {
            let head_line = match at {
                HeadAt::Screen(r) => self.screen_top() + r as u64,
                HeadAt::History(i) => self.history_base + i as u64,
            };
            let h = self.head_mut(at);
            if matches!(h.state, BlockState::Prompt | BlockState::Input) {
                h.state = BlockState::Running;
                h.output_line = Some(line);
                h.started = Some(std::time::Instant::now());
                let command = h.command.as_deref().unwrap_or_default().to_owned();
                self.events.push(Event::BlockStart { line: head_line, command });
                self.touch_head(at);
            }
        }
    }

    /// OSC 133 D (the terminal measured the duration) or OSC 7777 done (the shell reports it):
    /// the command at the newest block head ended. `D` without a code after a prompt that ran
    /// nothing (Ctrl+C, a bare Enter) ends nothing.
    fn block_end(&mut self, exit: Option<i32>, ms: Option<u32>) {
        if self.modes.alt_screen {
            return;
        }
        let Some(at) = self.find_head(self.cursor.row) else { return };
        let line = match at {
            HeadAt::Screen(r) => self.screen_top() + r as u64,
            HeadAt::History(i) => self.history_base + i as u64,
        };
        let h = self.head_mut(at);
        let ran = h.state == BlockState::Running;
        if matches!(h.state, BlockState::Done { .. }) || (!ran && exit.is_none()) {
            return;
        }
        let measured = h.started.map(|t| t.elapsed().as_millis().min(u32::MAX as u128) as u32);
        let ms = ms.or(measured).unwrap_or(0);
        let exit = exit.unwrap_or(0);
        h.state = BlockState::Done { exit, ms };
        let command = h.command.as_deref().unwrap_or_default().to_owned();
        self.events.push(Event::BlockEnd { line, command, exit, ms });
        self.touch_head(at);
    }

    /// The newest block head at or above `line`: its line number and the head. `None` before the
    /// first block or on the alternate screen.
    pub fn block_head_at(&self, line: u64) -> Option<(u64, &BlockHead)> {
        if self.modes.alt_screen {
            return None;
        }
        let base = self.history_base;
        let i = usize::try_from(line.checked_sub(base)?).ok()?;
        let history = self.scrollback.len();
        let on_screen = if i >= history {
            let r = (i - history).min(self.rows - 1);
            (0..=r).rev().find(|&r| self.primary[r].block.is_some()).map(HeadAt::Screen)
        } else {
            None
        };
        let at = on_screen.or_else(|| {
            let upto = if i >= history { history } else { i + 1 };
            self.scrollback.last_head_before(upto).map(HeadAt::History)
        })?;
        Some(match at {
            HeadAt::Screen(r) => (base + (history + r) as u64, self.primary[r].block.as_deref()?),
            HeadAt::History(j) => (base + j as u64, self.scrollback.head(j)?),
        })
    }

    /// The block `line` is in (docs/03 §6.3). A block that is still running ends at the cursor.
    pub fn block_at(&self, line: u64) -> Option<BlockRange<'_>> {
        let (start, head) = self.block_head_at(line)?;
        let end = self.block_jump(start, 1).map_or(self.cursor_line(), |next| next - 1);
        Some(BlockRange { line: start, head, end })
    }

    /// Every block head in the scrollback and on the screen, oldest first: its line number and head.
    pub fn block_heads(&self) -> Vec<(u64, &BlockHead)> {
        if self.modes.alt_screen {
            return Vec::new();
        }
        let base = self.history_base;
        let history = self.scrollback.len();
        self.scrollback
            .heads()
            .map(|(i, h)| (base + i as u64, h))
            .chain(
                self.primary
                    .iter()
                    .enumerate()
                    .filter_map(|(r, row)| Some((base + (history + r) as u64, row.block.as_deref()?))),
            )
            .collect()
    }

    /// The line of the nearest block head strictly above (`dir < 0`) or below (`dir > 0`) `line`.
    pub fn block_jump(&self, line: u64, dir: i32) -> Option<u64> {
        if self.modes.alt_screen {
            return None;
        }
        let mut heads = self.block_heads().into_iter().map(|(l, _)| l);
        if dir < 0 { heads.take_while(|&l| l < line).last() } else { heads.find(|&l| l > line) }
    }

    /// Scroll the region up by `n`: lines leave at the top, blanks enter at the bottom.
    fn scroll_up(&mut self, n: usize) {
        self.scroll_region_up(n, true);
    }

    /// Like [`Self::scroll_up`]; lines leaving the top of the primary screen go to scrollback only
    /// when `keep` is set.
    fn scroll_region_up(&mut self, n: usize, keep: bool) {
        let (top, bottom) = (self.scroll_top, self.scroll_bottom);
        let n = n.min(bottom - top + 1);
        let pen = self.pen;
        let cols = self.cols;
        let to_scrollback = keep && top == 0 && !self.modes.alt_screen;
        for _ in 0..n {
            let mut row = self.grid().remove(top).expect("top is on screen");
            // History keeps a trimmed copy; the screen row, still in cache, is cleared and reused.
            // Reusing old history rows instead meant touching memory written ~10,000 lines ago.
            if to_scrollback {
                self.push_history(row.compact());
            }
            if row.cells.len() == cols {
                row.clear(&pen);
            } else {
                row = Row::new(cols, &pen);
            }
            self.grid().insert(bottom, row);
        }
        self.touch_range(top, bottom);
    }

    /// Scroll the region down by `n`: blanks enter at the top.
    fn scroll_down(&mut self, n: usize) {
        let (top, bottom) = (self.scroll_top, self.scroll_bottom);
        let n = n.min(bottom - top + 1);
        let pen = self.pen;
        for _ in 0..n {
            let mut row = self.grid().remove(bottom).expect("bottom is on screen");
            row.clear(&pen);
            self.grid().insert(top, row);
        }
        self.touch_range(top, bottom);
    }

    fn linefeed(&mut self) {
        self.cursor.pending_wrap = false;
        if self.cursor.row == self.scroll_bottom {
            self.scroll_up(1);
        } else if self.cursor.row + 1 < self.rows {
            self.cursor.row += 1;
        }
    }

    fn reverse_index(&mut self) {
        self.cursor.pending_wrap = false;
        if self.cursor.row == self.scroll_top {
            self.scroll_down(1);
        } else if self.cursor.row > 0 {
            self.cursor.row -= 1;
        }
    }

    /// Move to (row, col), honoring origin mode for the row.
    fn goto(&mut self, row: usize, col: usize) {
        let (min_row, max_row) =
            if self.modes.origin { (self.scroll_top, self.scroll_bottom) } else { (0, self.rows - 1) };
        let row = if self.modes.origin { row + self.scroll_top } else { row };
        self.cursor = Cursor { row: row.clamp(min_row, max_row), col: col.min(self.cols - 1), pending_wrap: false };
    }

    fn char_width(&self, c: char) -> usize {
        if (' '..='~').contains(&c) {
            return 1;
        }
        let w = if self.ambiguous_wide { c.width_cjk() } else { c.width() };
        w.unwrap_or(0)
    }

    fn print_char(&mut self, c: char) {
        let c = if self.charsets[self.active_charset] == Charset::DecGraphics { dec_graphics(c) } else { c };
        if self.join_cluster(c) {
            return;
        }
        let width = self.char_width(c);

        if width == 0 {
            self.append_combining(c);
            return;
        }
        self.last_char = Some(c);

        if self.cursor.pending_wrap && self.modes.autowrap {
            let row = self.cursor.row;
            self.grid()[row].wrapped = true;
            self.cursor.col = 0;
            self.linefeed();
        }
        // A wide character that does not fit at the end of the line wraps first.
        if width == 2 && self.cursor.col + 1 >= self.cols {
            if self.modes.autowrap && self.cols > 1 {
                let (row, col) = (self.cursor.row, self.cursor.col);
                self.erase_cells(row, col, self.cols);
                self.grid()[row].wrapped = true;
                self.cursor.col = 0;
                self.linefeed();
            } else {
                return;
            }
        }

        let (row, col) = (self.cursor.row, self.cursor.col);
        if self.modes.insert {
            let cols = self.cols;
            let pen = self.pen;
            let r = &mut self.grid()[row];
            r.cells.splice(col..col, std::iter::repeat_n(Cell::blank(&pen), width));
            r.cells.truncate(cols);
            let shifted = r.used + width;
            r.touch_to(shifted);
            r.shift_extra(col, width as isize, cols);
        }
        // Overwriting one half of a wide character clears the other half.
        let cols = self.cols;
        let touches_wide = {
            let cells = &self.screen()[row].cells;
            cells[col].attrs.flags & flags::LAYOUT != 0
                || (col + width < cols && cells[col + width].is_spacer())
                || (width == 2 && cells[col + 1].attrs.flags & flags::LAYOUT != 0)
        };
        if touches_wide {
            self.erase_cells(row, col, col + width);
        }

        let mut attrs = self.pen;
        attrs.flags &= !flags::LAYOUT;
        let r = &mut self.grid()[row];
        r.clear_extra(col, col + width);
        r.touch_to(col + width);
        if width == 2 {
            r.cells[col] = Cell { ch: c, attrs: Attrs { flags: attrs.flags | flags::WIDE, ..attrs } };
            r.cells[col + 1] = Cell { ch: ' ', attrs: Attrs { flags: attrs.flags | flags::WIDE_SPACER, ..attrs } };
        } else {
            r.cells[col] = Cell { ch: c, attrs };
        }
        self.touch(row);

        if col + width >= self.cols {
            self.cursor.col = self.cols - 1;
            // Without autowrap the cursor stays put and the next character overwrites this one.
            self.cursor.pending_wrap = self.modes.autowrap;
        } else {
            self.cursor.col = col + width;
        }
    }

    /// The cell holding the character before the cursor (the left half if it is wide), if any.
    fn previous_cell(&self) -> Option<(usize, usize)> {
        let (row, mut col) = (self.cursor.row, self.cursor.col);
        if !self.cursor.pending_wrap {
            col = col.checked_sub(1)?;
        }
        let r = &self.screen()[row];
        if r.cells[col].is_spacer() && col > 0 {
            col -= 1;
        }
        Some((row, col))
    }

    /// Grapheme clusters counted the way ConPTY counts them (issue #7): a ZWJ sequence, an emoji
    /// with a skin tone, a pair of regional indicators (a flag) and a character followed by VS16
    /// are each one character, two cells wide. Returns true when `c` joined the previous cell.
    fn join_cluster(&mut self, c: char) -> bool {
        let is_ri = |ch: char| ('\u{1F1E6}'..='\u{1F1FF}').contains(&ch);
        let modifier = ('\u{1F3FB}'..='\u{1F3FF}').contains(&c);
        let vs16 = c == '\u{FE0F}';
        let Some((row, col)) = self.previous_cell() else { return false };
        let cell = self.screen()[row].cells[col];
        let extra = self.screen()[row].extra_at(col).unwrap_or("");
        let wide = cell.attrs.has(flags::WIDE);
        let after_zwj = extra.ends_with('\u{200D}');
        // The cell right after the previous one is where the cursor is: it can become the spacer.
        let adjacent = !self.cursor.pending_wrap && self.cursor.col == col + 1;
        if after_zwj || (modifier && wide) {
            self.append_combining(c);
            return true;
        }
        let widen = (vs16 && !wide) || (is_ri(c) && is_ri(cell.ch) && extra.is_empty() && !wide);
        if !widen {
            return false;
        }
        if adjacent {
            self.widen_previous(row, col);
        }
        self.append_combining(c);
        true
    }

    /// Make the narrow character at `col` two cells wide, taking the cell at the cursor.
    fn widen_previous(&mut self, row: usize, col: usize) {
        let spacer = col + 1;
        if spacer >= self.cols {
            return;
        }
        self.erase_cells(row, spacer, spacer + 1);
        let r = &mut self.grid()[row];
        let attrs = r.cells[col].attrs;
        r.cells[col].attrs.flags |= flags::WIDE;
        r.cells[spacer] =
            Cell { ch: ' ', attrs: Attrs { flags: (attrs.flags & !flags::LAYOUT) | flags::WIDE_SPACER, ..attrs } };
        r.touch_to(spacer + 1);
        self.touch(row);
        if spacer + 1 >= self.cols {
            self.cursor.col = self.cols - 1;
            self.cursor.pending_wrap = self.modes.autowrap;
        } else {
            self.cursor.col = spacer + 1;
        }
    }

    /// Attach a zero-width character (combining mark, ZWJ, variation selector) to the previous cell.
    fn append_combining(&mut self, c: char) {
        let (row, mut col) = (self.cursor.row, self.cursor.col);
        if !self.cursor.pending_wrap {
            if col == 0 {
                return;
            }
            col -= 1;
        }
        let r = &mut self.grid()[row];
        if r.cells[col].is_spacer() && col > 0 {
            col -= 1;
        }
        let key = col as u16;
        match r.extra.binary_search_by_key(&key, |(c, _)| *c) {
            Ok(i) => {
                let mut s = String::from(std::mem::take(&mut r.extra[i].1));
                s.push(c);
                r.extra[i].1 = s.into_boxed_str();
            }
            Err(i) => r.extra.insert(i, (key, String::from(c).into_boxed_str())),
        }
        self.touch(row);
    }

    fn switch_screen(&mut self, alt: bool, save_cursor: bool, clear: bool) {
        if alt == self.modes.alt_screen {
            return;
        }
        if alt {
            if save_cursor {
                self.save_cursor();
            }
            self.modes.alt_screen = true;
            if clear {
                let pen = Attrs::default();
                let cols = self.cols;
                self.alt.iter_mut().for_each(|r| *r = Row::new(cols, &pen));
            }
        } else {
            self.modes.alt_screen = false;
            if save_cursor {
                self.restore_cursor();
            }
        }
        self.update_kitty_mode();
        self.full_damage = true;
    }

    // --- Kitty keyboard protocol (decision I3) --------------------------------

    fn kitty_stack(&mut self) -> &mut Vec<u8> {
        &mut self.kitty[self.modes.alt_screen as usize]
    }

    fn update_kitty_mode(&mut self) {
        self.modes.kitty_keyboard = self.kitty[self.modes.alt_screen as usize].last().copied().unwrap_or(0);
    }

    /// `CSI > flags u`, `CSI < n u`, `CSI = flags ; mode u`, `CSI ? u`.
    fn kitty_keyboard(&mut self, marker: u8, params: &Params) {
        if !self.kitty_enabled {
            return;
        }
        let raw = |i: usize| params.iter().nth(i).map_or(0, |p| p[0]);
        match marker {
            b'>' => {
                let stack = self.kitty_stack();
                if stack.len() == KITTY_STACK_LIMIT {
                    stack.remove(0);
                }
                stack.push(raw(0) as u8 & KITTY_SUPPORTED);
            }
            b'<' => {
                let n = raw(0).max(1) as usize;
                let stack = self.kitty_stack();
                stack.truncate(stack.len().saturating_sub(n));
            }
            b'=' => {
                let flags = raw(0) as u8 & KITTY_SUPPORTED;
                let mode = raw(1).max(1);
                let stack = self.kitty_stack();
                if stack.is_empty() {
                    stack.push(0);
                }
                let top = stack.last_mut().expect("not empty");
                *top = match mode {
                    1 => flags,
                    2 => *top | flags,
                    3 => *top & !flags,
                    _ => *top,
                };
            }
            b'?' => {
                let flags = self.modes.kitty_keyboard;
                self.responses.extend_from_slice(format!("\x1b[?{flags}u").as_bytes());
            }
            _ => {}
        }
        self.update_kitty_mode();
    }

    fn save_cursor(&mut self) {
        let i = self.modes.alt_screen as usize;
        self.saved[i] = Saved {
            cursor: self.cursor,
            pen: self.pen,
            origin: self.modes.origin,
            charsets: self.charsets,
            active_charset: self.active_charset,
        };
    }

    fn restore_cursor(&mut self) {
        let s = self.saved[self.modes.alt_screen as usize];
        self.cursor = s.cursor;
        self.cursor.row = self.cursor.row.min(self.rows - 1);
        self.cursor.col = self.cursor.col.min(self.cols - 1);
        self.pen = s.pen;
        self.modes.origin = s.origin;
        self.charsets = s.charsets;
        self.active_charset = s.active_charset;
    }

    fn reset(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        let limit = self.scrollback_limit;
        let ambiguous = self.ambiguous_wide;
        let base = self.history_base + self.scrollback.len() as u64;
        let spill = self.scrollback.spill();
        let (shape, blink) = self.default_cursor;
        let kitty_enabled = self.kitty_enabled;
        let colors = self.colors;
        *self = Terminal::new(cols, rows);
        self.colors = colors;
        self.set_default_cursor(shape, blink);
        self.kitty_enabled = kitty_enabled;
        self.history_base = base;
        self.scrollback_limit = limit;
        self.scrollback.set_spill(spill);
        self.ambiguous_wide = ambiguous;
    }

    // --- control sequences ---------------------------------------------------------

    fn set_private_mode(&mut self, mode: u16, on: bool) {
        match mode {
            1 => self.modes.app_cursor = on,
            6 => {
                self.modes.origin = on;
                self.goto(0, 0);
            }
            7 => self.modes.autowrap = on,
            12 => self.modes.cursor_blink = on,
            25 => self.modes.cursor_visible = on,
            47 | 1047 => self.switch_screen(on, false, on),
            1048 => {
                if on {
                    self.save_cursor()
                } else {
                    self.restore_cursor()
                }
            }
            1049 => self.switch_screen(on, true, true),
            1000 => self.modes.mouse = if on { MouseMode::Click } else { MouseMode::Off },
            1002 => self.modes.mouse = if on { MouseMode::Drag } else { MouseMode::Off },
            1003 => self.modes.mouse = if on { MouseMode::Motion } else { MouseMode::Off },
            1004 => self.modes.focus_events = on,
            1006 => self.modes.mouse_sgr = on,
            2004 => self.modes.bracketed_paste = on,
            2026 => self.modes.synchronized_output = on,
            _ => {}
        }
    }

    /// The state of a private mode for DECRQM, `None` when otterm does not know it.
    fn private_mode(&self, mode: u16) -> Option<bool> {
        let m = &self.modes;
        Some(match mode {
            1 => m.app_cursor,
            6 => m.origin,
            7 => m.autowrap,
            12 => m.cursor_blink,
            25 => m.cursor_visible,
            47 | 1047 | 1049 => m.alt_screen,
            1000 => m.mouse == MouseMode::Click,
            1002 => m.mouse == MouseMode::Drag,
            1003 => m.mouse == MouseMode::Motion,
            1004 => m.focus_events,
            1006 => m.mouse_sgr,
            2004 => m.bracketed_paste,
            2026 => m.synchronized_output,
            _ => return None,
        })
    }

    fn set_mode(&mut self, mode: u16, on: bool) {
        match mode {
            4 => self.modes.insert = on,
            20 => self.modes.newline = on,
            _ => {}
        }
    }

    fn sgr(&mut self, params: &Params) {
        let mut it = params.iter();
        // SGR resets colors and styles, not the hyperlink (that is OSC 8's).
        let link = self.pen.link;
        if params.is_empty() {
            self.pen = Attrs { link, ..Attrs::default() };
            return;
        }
        while let Some(p) = it.next() {
            let f = &mut self.pen.flags;
            match p[0] {
                0 => self.pen = Attrs { link, ..Attrs::default() },
                1 => *f |= flags::BOLD,
                2 => *f |= flags::DIM,
                3 => *f |= flags::ITALIC,
                4 => {
                    *f &= !flags::ANY_UNDERLINE;
                    match p.get(1).copied() {
                        Some(0) => {}
                        Some(2) => *f |= flags::DOUBLE_UNDERLINE,
                        Some(3) => *f |= flags::CURLY_UNDERLINE,
                        _ => *f |= flags::UNDERLINE,
                    }
                }
                5 | 6 => *f |= flags::BLINK,
                7 => *f |= flags::INVERSE,
                8 => *f |= flags::HIDDEN,
                9 => *f |= flags::STRIKE,
                21 => {
                    *f &= !flags::ANY_UNDERLINE;
                    *f |= flags::DOUBLE_UNDERLINE;
                }
                22 => *f &= !(flags::BOLD | flags::DIM),
                23 => *f &= !flags::ITALIC,
                24 => *f &= !flags::ANY_UNDERLINE,
                25 => *f &= !flags::BLINK,
                27 => *f &= !flags::INVERSE,
                28 => *f &= !flags::HIDDEN,
                29 => *f &= !flags::STRIKE,
                53 => *f |= flags::OVERLINE,
                55 => *f &= !flags::OVERLINE,
                30..=37 => self.pen.fg = Color::Indexed((p[0] - 30) as u8),
                39 => self.pen.fg = Color::Default,
                40..=47 => self.pen.bg = Color::Indexed((p[0] - 40) as u8),
                49 => self.pen.bg = Color::Default,
                59 => self.pen.underline_color = Color::Default,
                90..=97 => self.pen.fg = Color::Indexed((p[0] - 90 + 8) as u8),
                100..=107 => self.pen.bg = Color::Indexed((p[0] - 100 + 8) as u8),
                38 | 48 | 58 => {
                    let color = extended_color(p, &mut it);
                    if let Some(color) = color {
                        match p[0] {
                            38 => self.pen.fg = color,
                            48 => self.pen.bg = color,
                            _ => self.pen.underline_color = color,
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn erase_display(&mut self, mode: u16) {
        let (row, col) = (self.cursor.row, self.cursor.col);
        let (rows, cols) = (self.rows, self.cols);
        match mode {
            0 => {
                self.erase_cells(row, col, cols);
                for r in row + 1..rows {
                    self.erase_cells(r, 0, cols);
                }
            }
            1 => {
                for r in 0..row {
                    self.erase_cells(r, 0, cols);
                }
                self.erase_cells(row, 0, col + 1);
            }
            2 => {
                for r in 0..rows {
                    self.erase_cells(r, 0, cols);
                }
            }
            3 => self.clear_scrollback(),
            _ => {}
        }
        if mode != 3 {
            for r in 0..rows {
                self.grid()[r].wrapped = false;
            }
        }
    }

    fn erase_line(&mut self, mode: u16) {
        let (row, col, cols) = (self.cursor.row, self.cursor.col, self.cols);
        match mode {
            0 => self.erase_cells(row, col, cols),
            1 => self.erase_cells(row, 0, col + 1),
            2 => self.erase_cells(row, 0, cols),
            _ => {}
        }
    }

    fn insert_lines(&mut self, n: usize) {
        let row = self.cursor.row;
        if row < self.scroll_top || row > self.scroll_bottom {
            return;
        }
        let top = self.scroll_top;
        self.scroll_top = row;
        self.scroll_down(n);
        self.scroll_top = top;
        self.cursor.col = 0;
    }

    fn delete_lines(&mut self, n: usize) {
        let row = self.cursor.row;
        if row < self.scroll_top || row > self.scroll_bottom {
            return;
        }
        let top = self.scroll_top;
        self.scroll_top = row;
        // Lines deleted inside the screen never go to scrollback.
        self.scroll_region_up(n, false);
        self.scroll_top = top;
        self.cursor.col = 0;
    }

    fn insert_chars(&mut self, n: usize) {
        let (row, col, cols) = (self.cursor.row, self.cursor.col, self.cols);
        let pen = self.pen;
        let n = n.min(cols - col);
        let r = &mut self.grid()[row];
        r.cells.splice(col..col, std::iter::repeat_n(Cell::blank(&pen), n));
        r.cells.truncate(cols);
        let shifted = r.used + n;
        r.touch_to(shifted);
        r.shift_extra(col, n as isize, cols);
        self.touch(row);
    }

    fn delete_chars(&mut self, n: usize) {
        let (row, col, cols) = (self.cursor.row, self.cursor.col, self.cols);
        let pen = self.pen;
        let n = n.min(cols - col);
        let r = &mut self.grid()[row];
        r.cells.drain(col..col + n);
        r.cells.resize(cols, Cell::blank(&pen));
        if pen.bg != Color::Default {
            r.touch_to(cols);
        }
        r.shift_extra(col, -(n as isize), cols);
        self.touch(row);
    }

    fn tab_forward(&mut self, n: usize) {
        for _ in 0..n {
            let next = (self.cursor.col + 1..self.cols).find(|&c| self.tabs[c]);
            self.cursor.col = next.unwrap_or(self.cols - 1);
        }
        self.cursor.pending_wrap = false;
    }

    fn tab_backward(&mut self, n: usize) {
        for _ in 0..n {
            let prev = (0..self.cursor.col).rev().find(|&c| self.tabs[c]);
            self.cursor.col = prev.unwrap_or(0);
        }
        self.cursor.pending_wrap = false;
    }

    fn respond(&mut self, s: &str) {
        self.responses.extend_from_slice(s.as_bytes());
    }
}

/// A row with nothing on it that does not continue on the next one.
fn is_blank(row: &Row) -> bool {
    !row.wrapped && row.extra.is_empty() && row.cells.iter().all(|c| *c == Cell::default())
}

fn default_tabs(cols: usize) -> Vec<bool> {
    (0..cols).map(|c| c > 0 && c % 8 == 0).collect()
}

/// Parameter `i`, where 0 or missing means `default`.
fn arg(params: &Params, i: usize, default: u16) -> u16 {
    match params.iter().nth(i).map(|p| p[0]) {
        None | Some(0) => default,
        Some(v) => v,
    }
}

/// `38;5;n`, `38;2;r;g;b` and their colon forms (`38:5:n`, `38:2::r:g:b`).
fn extended_color<'a>(p: &[u16], it: &mut impl Iterator<Item = &'a [u16]>) -> Option<Color> {
    if p.len() > 1 {
        return match p[1] {
            5 => p.get(2).map(|&n| Color::Indexed(n as u8)),
            2 => {
                // With a color-space id (38:2:id:r:g:b) there are six parts, otherwise five.
                let rgb = if p.len() >= 6 { &p[3..6] } else { p.get(2..5)? };
                Some(Color::Rgb(rgb[0] as u8, rgb[1] as u8, rgb[2] as u8))
            }
            _ => None,
        };
    }
    match it.next()?[0] {
        5 => Some(Color::Indexed(it.next()?[0] as u8)),
        2 => {
            let r = it.next()?[0];
            let g = it.next()?[0];
            let b = it.next()?[0];
            Some(Color::Rgb(r as u8, g as u8, b as u8))
        }
        _ => None,
    }
}

/// DEC Special Graphics for `ESC ( 0`.
fn dec_graphics(c: char) -> char {
    match c {
        '`' => '◆',
        'a' => '▒',
        'f' => '°',
        'g' => '±',
        'j' => '┘',
        'k' => '┐',
        'l' => '┌',
        'm' => '└',
        'n' => '┼',
        'o' => '⎺',
        'p' => '⎻',
        'q' => '─',
        'r' => '⎼',
        's' => '⎽',
        't' => '├',
        'u' => '┤',
        'v' => '┴',
        'w' => '┬',
        'x' => '│',
        'y' => '≤',
        'z' => '≥',
        '{' => 'π',
        '|' => '≠',
        '}' => '£',
        '~' => '·',
        _ => c,
    }
}

impl Perform for Terminal {
    fn print(&mut self, c: char) {
        self.print_char(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            0x07 => self.events.push(Event::Bell),
            0x08 => {
                // Like xterm: a pending wrap is dropped and the cursor still steps back.
                self.cursor.pending_wrap = false;
                self.cursor.col = self.cursor.col.saturating_sub(1);
            }
            0x09 => self.tab_forward(1),
            0x0a..=0x0c => {
                self.linefeed();
                if self.modes.newline {
                    self.cursor.col = 0;
                }
            }
            0x0d => {
                self.cursor.col = 0;
                self.cursor.pending_wrap = false;
            }
            0x0e => self.active_charset = 1,
            0x0f => self.active_charset = 0,
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        let private = intermediates.first() == Some(&b'?');
        let n = |i: usize| arg(params, i, 1) as usize;
        let (row, col) = (self.cursor.row, self.cursor.col);
        match (action, intermediates) {
            ('h', _) | ('l', _) => {
                let on = action == 'h';
                for p in params.iter() {
                    if private { self.set_private_mode(p[0], on) } else { self.set_mode(p[0], on) }
                }
            }
            ('m', []) => self.sgr(params),
            ('@', []) => self.insert_chars(n(0)),
            ('A', []) => {
                let top = if row >= self.scroll_top { self.scroll_top } else { 0 };
                self.cursor.row = row.saturating_sub(n(0)).max(top);
                self.cursor.pending_wrap = false;
            }
            ('B', []) | ('e', []) => {
                let bottom = if row <= self.scroll_bottom { self.scroll_bottom } else { self.rows - 1 };
                self.cursor.row = (row + n(0)).min(bottom);
                self.cursor.pending_wrap = false;
            }
            ('C', []) | ('a', []) => {
                self.cursor.col = (col + n(0)).min(self.cols - 1);
                self.cursor.pending_wrap = false;
            }
            ('D', []) => {
                self.cursor.col = col.saturating_sub(n(0));
                self.cursor.pending_wrap = false;
            }
            ('E', []) => {
                self.cursor.row = (row + n(0)).min(self.scroll_bottom.max(row));
                self.cursor.col = 0;
                self.cursor.pending_wrap = false;
            }
            ('F', []) => {
                self.cursor.row = row.saturating_sub(n(0)).max(self.scroll_top.min(row));
                self.cursor.col = 0;
                self.cursor.pending_wrap = false;
            }
            ('G', []) | ('`', []) => {
                self.cursor.col = (n(0) - 1).min(self.cols - 1);
                self.cursor.pending_wrap = false;
            }
            ('H', []) | ('f', []) => self.goto(n(0) - 1, n(1) - 1),
            ('I', []) => self.tab_forward(n(0)),
            ('J', []) => self.erase_display(arg(params, 0, 0)),
            ('K', []) => self.erase_line(arg(params, 0, 0)),
            // Selective erase (DECSED / DECSEL) behaves like the plain erase here.
            ('J', [b'?']) => self.erase_display(arg(params, 0, 0)),
            ('K', [b'?']) => self.erase_line(arg(params, 0, 0)),
            ('L', []) => self.insert_lines(n(0)),
            ('M', []) => self.delete_lines(n(0)),
            ('P', []) => self.delete_chars(n(0)),
            ('S', []) => self.scroll_up(n(0)),
            ('T', []) => self.scroll_down(n(0)),
            ('X', []) => {
                let end = col + n(0);
                self.erase_cells(row, col, end);
            }
            ('Z', []) => self.tab_backward(n(0)),
            ('b', []) => {
                if let Some(c) = self.last_char {
                    for _ in 0..n(0).min(self.cols * self.rows) {
                        self.print_char(c);
                    }
                }
            }
            ('c', []) if arg(params, 0, 0) == 0 => self.respond("\x1b[?62;22c"),
            ('c', [b'>']) => self.respond("\x1b[>1;10;0c"),
            // XTVERSION: the terminal's name and version.
            ('q', [b'>']) => {
                let s = format!("\x1bP>|otterm {}\x1b\\", env!("CARGO_PKG_VERSION"));
                self.respond(&s);
            }
            // DECRQM: is a mode set (1), reset (2) or unknown (0)?
            ('p', [b'?', b'$']) => {
                let mode = arg(params, 0, 0);
                let state = match self.private_mode(mode) {
                    // Grapheme clustering is always on, as in ConPTY (issue #7): "permanently set".
                    _ if mode == 2027 => 3,
                    Some(true) => 1,
                    Some(false) => 2,
                    None => 0,
                };
                let s = format!("\x1b[?{mode};{state}$y");
                self.respond(&s);
            }
            ('d', []) => {
                let col = self.cursor.col;
                self.goto(n(0) - 1, col);
            }
            ('g', []) => match arg(params, 0, 0) {
                0 => {
                    if let Some(t) = self.tabs.get_mut(col) {
                        *t = false;
                    }
                }
                3 => self.tabs.iter_mut().for_each(|t| *t = false),
                _ => {}
            },
            ('n', []) => match arg(params, 0, 0) {
                5 => self.respond("\x1b[0n"),
                6 => {
                    let r = if self.modes.origin { row - self.scroll_top } else { row };
                    let s = format!("\x1b[{};{}R", r + 1, col + 1);
                    self.respond(&s);
                }
                _ => {}
            },
            ('r', []) => {
                let top = n(0) - 1;
                let bottom = (arg(params, 1, self.rows as u16) as usize).min(self.rows) - 1;
                if top < bottom {
                    self.scroll_top = top;
                    self.scroll_bottom = bottom;
                    self.goto(0, 0);
                }
            }
            ('s', []) => self.save_cursor(),
            ('u', []) => self.restore_cursor(),
            ('u', [marker @ (b'>' | b'<' | b'=' | b'?')]) => self.kitty_keyboard(*marker, params),
            ('q', [b' ']) => {
                let (shape, blink) = match arg(params, 0, 0) {
                    0 => self.default_cursor,
                    1 => (CursorShape::Block, true),
                    2 => (CursorShape::Block, false),
                    3 => (CursorShape::Underline, true),
                    4 => (CursorShape::Underline, false),
                    5 => (CursorShape::Bar, true),
                    _ => (CursorShape::Bar, false),
                };
                self.modes.cursor_shape = shape;
                self.modes.cursor_blink = blink;
                self.touch(row);
            }
            ('p', [b'!']) => {
                // DECSTR soft reset: modes and pen, not the screen.
                self.pen = Attrs::default();
                self.modes = Modes { alt_screen: self.modes.alt_screen, ..Modes::default() };
                self.scroll_top = 0;
                self.scroll_bottom = self.rows - 1;
                self.charsets = [Charset::Ascii; 2];
                self.active_charset = 0;
            }
            _ => {}
        }
    }

    fn esc_dispatch(&mut self, intermediates: &[u8], ignore: bool, byte: u8) {
        if ignore {
            return;
        }
        match (intermediates, byte) {
            ([], b'7') => self.save_cursor(),
            ([], b'8') => self.restore_cursor(),
            ([], b'D') => self.linefeed(),
            ([], b'E') => {
                self.linefeed();
                self.cursor.col = 0;
            }
            ([], b'H') => {
                let col = self.cursor.col;
                if let Some(t) = self.tabs.get_mut(col) {
                    *t = true;
                }
            }
            ([], b'M') => self.reverse_index(),
            ([], b'c') => self.reset(),
            ([], b'=') => self.modes.app_keypad = true,
            ([], b'>') => self.modes.app_keypad = false,
            ([b'('], c) | ([b')'], c) => {
                let slot = if intermediates[0] == b'(' { 0 } else { 1 };
                self.charsets[slot] = if c == b'0' { Charset::DecGraphics } else { Charset::Ascii };
            }
            ([b'#'], b'8') => {
                // DECALN: fill the screen with 'E' (used by vttest).
                let cols = self.cols;
                for row in self.grid().iter_mut() {
                    row.cells = vec![Cell { ch: 'E', ..Cell::default() }; cols];
                    row.extra.clear();
                    row.touch_to(cols);
                }
                // Like xterm: the margins are reset and the cursor goes home.
                self.scroll_top = 0;
                self.scroll_bottom = self.rows - 1;
                self.modes.origin = false;
                self.cursor = Cursor { row: 0, col: 0, pending_wrap: false };
                self.full_damage = true;
            }
            _ => {}
        }
    }

    fn osc_dispatch(&mut self, params: &[&[u8]], _bell_terminated: bool) {
        let Some(cmd) = params.first() else { return };
        let text = |i: usize| params.get(i).map(|p| String::from_utf8_lossy(p).into_owned()).unwrap_or_default();
        match *cmd {
            b"0" | b"2" => {
                // Titles may contain ';', which the parser splits on.
                let title = params[1..].iter().map(|p| String::from_utf8_lossy(p)).collect::<Vec<_>>().join(";");
                self.title = title.clone();
                self.events.push(Event::Title(title));
            }
            b"7" => self.events.push(Event::Cwd(text(1))),
            // OSC 8 ; params ; URI. The URI may itself contain ';'.
            b"8" => {
                let uri = params
                    .get(2..)
                    .unwrap_or_default()
                    .iter()
                    .map(|p| String::from_utf8_lossy(p))
                    .collect::<Vec<_>>()
                    .join(";");
                self.set_link(&uri);
            }
            // OSC 10 / 11 / 12 ; ? : report the default foreground / background / cursor color.
            b"10" | b"11" | b"12" if params.get(1).is_some_and(|p| *p == b"?") => {
                let which = (cmd[1] - b'0') as usize;
                let (r, g, b) = self.colors[which];
                let s = format!("\x1b]1{which};rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}\x1b\\");
                self.respond(&s);
            }
            // Shell integration (docs/03 §6.1): the prompt starts (A), the user types (B), the
            // command runs (C) and ends with an exit code (D).
            b"133" => match params.get(1).copied() {
                Some(b"A") => self.block_prompt_start(),
                Some(b"B") => self.block_input_start(),
                Some(b"C") => self.block_command_start(),
                Some(b"D") => self.block_end(text(2).parse().ok(), None),
                _ => {}
            },
            // otterm's extension: `7777;cmd;<base64>` is the command line, `7777;bar;<base64
            // JSON>` starts a prompt bar at the cursor (decision M4), `7777;done;<exit>;<ms>` ends
            // the command with a duration the shell measured.
            b"7777" => match params.get(1).copied() {
                Some(b"cmd") => {
                    if let Some(command) = decode_base64(&text(2)) {
                        self.block_command(command);
                    }
                }
                Some(b"bar") => self.block_bar(text(2)),
                // `7777;line;<cursor>;<percent-encoded line>`: the line editor's buffer (zsh).
                Some(b"line") => {
                    if let (Ok(cursor), Some(line)) = (text(2).parse::<usize>(), percent_decode(&text(3))) {
                        self.block_input_exact(line, cursor);
                    }
                }
                Some(b"done") => {
                    if let (Ok(code), Ok(ms)) = (text(2).parse::<i32>(), text(3).parse::<u32>()) {
                        self.block_end(Some(code), Some(ms));
                    }
                }
                _ => {}
            },
            b"52" => {
                let data = text(2);
                if data != "?" {
                    self.events.push(Event::ClipboardWrite(data));
                }
            }
            _ => {}
        }
    }
}

/// `%XX`-encoded UTF-8 text (OSC 7777 line); `None` when the bytes are not UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
        {
            out.push(b);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Standard base64 (padding optional) to UTF-8 text; `None` for anything else.
fn decode_base64(s: &str) -> Option<String> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes().filter(|c| !c.is_ascii_whitespace()) {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => return None,
        };
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    String::from_utf8(out).ok()
}
