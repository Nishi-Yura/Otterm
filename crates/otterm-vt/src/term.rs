//! Terminal state machine: applies parsed VT sequences to a grid.
//! Spec: docs/03-core-features.md §2.1 (supported sequences).

use std::collections::VecDeque;

use unicode_width::UnicodeWidthChar;
use vte::{Params, Perform};

use crate::cell::{Attrs, Cell, Color, Row, flags};

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
            autowrap: true,
            origin: false,
            insert: false,
            newline: false,
        }
    }
}

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
}

pub struct Terminal {
    rows: usize,
    cols: usize,
    /// Ring buffers so that scrolling the whole screen is O(1).
    primary: VecDeque<Row>,
    alt: VecDeque<Row>,
    scrollback: VecDeque<Row>,
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
            scrollback: VecDeque::new(),
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

    /// Lines that scrolled off the top of the primary screen, oldest first.
    pub fn scrollback(&self) -> &VecDeque<Row> {
        &self.scrollback
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
    pub fn line(&self, line: u64) -> Option<&Row> {
        let i = usize::try_from(line.checked_sub(self.history_base)?).ok()?;
        match i.checked_sub(self.scrollback.len()) {
            None => self.scrollback.get(i),
            Some(r) => self.screen().get(r),
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

    /// Drop the scrollback (the context menu's "clear scrollback"; ED 3 does the same).
    pub fn clear_scrollback(&mut self) {
        self.history_base += self.scrollback.len() as u64;
        self.scrollback.clear();
        self.full_damage = true;
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
            for row in self.primary.drain(..excess) {
                if !self.modes.alt_screen {
                    self.scrollback.push_back(row);
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
        for row in self.scrollback.iter_mut().filter(|r| r.cells.len() > cols) {
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

    /// Rewrap the primary screen and the scrollback for a new width (issue #2). Returns whether
    /// the cursor ends up waiting to wrap.
    fn reflow_primary(&mut self, cols: usize, rows: usize) -> bool {
        let mut all: Vec<Row> = self.scrollback.drain(..).chain(self.primary.drain(..)).collect();
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
        self.scrollback = out.iter().map(Row::compact).collect();
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
        while self.scrollback.len() > self.scrollback_limit {
            self.scrollback.pop_front();
            self.history_base += 1;
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
        if pen.bg != Color::Default {
            r.touch_to(to);
        }
        self.touch(row);
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
                self.scrollback.push_back(row.compact());
                if self.scrollback.len() > self.scrollback_limit {
                    self.scrollback.pop_front();
                    self.history_base += 1;
                }
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
            self.cursor.pending_wrap = true;
        } else {
            self.cursor.col = col + width;
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
        self.full_damage = true;
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
        let (shape, blink) = self.default_cursor;
        *self = Terminal::new(cols, rows);
        self.set_default_cursor(shape, blink);
        self.history_base = base;
        self.scrollback_limit = limit;
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

    fn set_mode(&mut self, mode: u16, on: bool) {
        match mode {
            4 => self.modes.insert = on,
            20 => self.modes.newline = on,
            _ => {}
        }
    }

    fn sgr(&mut self, params: &Params) {
        let mut it = params.iter();
        if params.is_empty() {
            self.pen = Attrs { flags: 0, ..Attrs::default() };
            return;
        }
        while let Some(p) = it.next() {
            let f = &mut self.pen.flags;
            match p[0] {
                0 => self.pen = Attrs::default(),
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
                if self.cursor.pending_wrap {
                    self.cursor.pending_wrap = false;
                } else {
                    self.cursor.col = self.cursor.col.saturating_sub(1);
                }
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

#[cfg(test)]
mod tests;
