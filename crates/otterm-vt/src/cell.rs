//! Cells and their attributes.
//!
//! [`Cell`] is a small `Copy` value (20 bytes) so that clearing and scrolling rows is a plain fill.
//! The rare combining characters of a grapheme cluster live beside the cells in [`Row`].

/// A color as the application asked for it. Resolving to RGB is the renderer's job (themes).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Color {
    #[default]
    Default,
    /// 0–15 are the ANSI colors the theme defines, 16–255 the xterm palette.
    Indexed(u8),
    Rgb(u8, u8, u8),
}

/// Text attribute bits.
pub mod flags {
    pub const BOLD: u16 = 1 << 0;
    pub const DIM: u16 = 1 << 1;
    pub const ITALIC: u16 = 1 << 2;
    pub const UNDERLINE: u16 = 1 << 3;
    pub const DOUBLE_UNDERLINE: u16 = 1 << 4;
    pub const CURLY_UNDERLINE: u16 = 1 << 5;
    pub const BLINK: u16 = 1 << 6;
    pub const INVERSE: u16 = 1 << 7;
    pub const HIDDEN: u16 = 1 << 8;
    pub const STRIKE: u16 = 1 << 9;
    pub const OVERLINE: u16 = 1 << 10;
    /// Left half of a double-width character.
    pub const WIDE: u16 = 1 << 11;
    /// Right half of a double-width character. Holds no text of its own.
    pub const WIDE_SPACER: u16 = 1 << 12;

    pub const ANY_UNDERLINE: u16 = UNDERLINE | DOUBLE_UNDERLINE | CURLY_UNDERLINE;
    /// Bits that describe the cell's shape, not the pen. Never copied from the pen.
    pub const LAYOUT: u16 = WIDE | WIDE_SPACER;
}

/// The "pen": what newly printed characters look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Attrs {
    pub fg: Color,
    pub bg: Color,
    pub underline_color: Color,
    pub flags: u16,
    /// OSC 8 hyperlink: an id from [`crate::Terminal::link`], 0 for none. Kept here so that every
    /// cell operation carries it along; it fits in the space `Cell` already had.
    pub link: u16,
}

impl Attrs {
    pub fn has(&self, flag: u16) -> bool {
        self.flags & flag != 0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cell {
    /// Base character. `' '` for blank cells and wide spacers. Combining characters that follow it
    /// are in [`Row::extra`].
    pub ch: char,
    pub attrs: Attrs,
}

impl Default for Cell {
    fn default() -> Self {
        Self { ch: ' ', attrs: Attrs::default() }
    }
}

impl Cell {
    /// A blank cell that keeps the background of `pen` (ECMA-48 "erase" semantics).
    pub fn blank(pen: &Attrs) -> Self {
        Self { ch: ' ', attrs: Attrs { bg: pen.bg, ..Attrs::default() } }
    }

    pub fn is_wide(&self) -> bool {
        self.attrs.has(flags::WIDE)
    }

    pub fn is_spacer(&self) -> bool {
        self.attrs.has(flags::WIDE_SPACER)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub cells: Vec<Cell>,
    /// Combining characters attached to a cell, by column, ascending. Usually empty.
    pub extra: Vec<(u16, Box<str>)>,
    /// The line continues on the next row because of autowrap (needed for copy and reflow).
    pub wrapped: bool,
    /// Every cell at or after this column is `Cell::default()`. Lets clearing and trimming skip
    /// the unused tail, which is most of a row in typical output.
    pub(crate) used: usize,
}

impl Row {
    pub fn new(cols: usize, pen: &Attrs) -> Self {
        let used = if pen.bg == Color::Default { 0 } else { cols };
        Self { cells: vec![Cell::blank(pen); cols], extra: Vec::new(), wrapped: false, used }
    }

    /// Record that cells before `to` may no longer be default.
    pub(crate) fn touch_to(&mut self, to: usize) {
        self.used = self.used.max(to.min(self.cells.len()));
    }

    /// A copy without trailing default cells, for scrollback. Readers treat missing cells as blank.
    pub fn compact(&self) -> Self {
        let used = self.cells[..self.used].iter().rposition(|c| *c != Cell::default()).map_or(0, |i| i + 1);
        Self { cells: self.cells[..used].to_vec(), extra: self.extra.clone(), wrapped: self.wrapped, used }
    }

    /// Like [`Self::compact`], in place: drop trailing default cells.
    pub(crate) fn compact_in_place(&mut self) {
        let used = self.cells[..self.used].iter().rposition(|c| *c != Cell::default()).map_or(0, |i| i + 1);
        self.cells.truncate(used);
        // Give memory back only when it is worth a reallocation (a screen row entering history).
        if self.cells.capacity() > used * 2 + 16 {
            self.cells.shrink_to_fit();
        }
        self.used = used;
    }

    /// Blank the whole row in place, keeping its allocation.
    pub fn clear(&mut self, pen: &Attrs) {
        if pen.bg == Color::Default {
            self.cells[..self.used].fill(Cell::default());
            self.used = 0;
        } else {
            self.cells.fill(Cell::blank(pen));
            self.used = self.cells.len();
        }
        self.extra.clear();
        self.wrapped = false;
    }

    pub fn resize(&mut self, cols: usize) {
        self.cells.resize(cols, Cell::default());
        self.used = self.used.min(cols);
        self.extra.retain(|(c, _)| (*c as usize) < cols);
        // A wide character cut in half by the new edge becomes a blank.
        if let Some(last) = self.cells.last_mut()
            && last.is_wide()
        {
            *last = Cell::default();
        }
    }

    /// Combining characters attached to the cell at `col`, if any.
    pub fn extra_at(&self, col: usize) -> Option<&str> {
        if self.extra.is_empty() {
            return None;
        }
        self.extra.iter().find(|(c, _)| *c as usize == col).map(|(_, s)| &**s)
    }

    /// Text of one cell: its character plus any combining characters.
    pub fn cell_text(&self, col: usize) -> String {
        let mut s = String::from(self.cells[col].ch);
        if let Some(extra) = self.extra_at(col) {
            s.push_str(extra);
        }
        s
    }

    /// Text of the row with trailing blanks removed. Wide spacers are skipped.
    pub fn text(&self) -> String {
        let mut s = String::with_capacity(self.cells.len());
        for (col, cell) in self.cells.iter().enumerate() {
            if cell.is_spacer() {
                continue;
            }
            s.push(cell.ch);
            if let Some(extra) = self.extra_at(col) {
                s.push_str(extra);
            }
        }
        s.truncate(s.trim_end_matches(' ').len());
        s
    }

    /// Drop combining characters in `from..to`.
    pub(crate) fn clear_extra(&mut self, from: usize, to: usize) {
        if !self.extra.is_empty() {
            self.extra.retain(|(c, _)| !((from..to).contains(&(*c as usize))));
        }
    }

    /// Shift combining characters at or after `from` by `delta` columns, dropping those that leave
    /// `0..cols` or land in `from..from - delta` (deleted cells).
    pub(crate) fn shift_extra(&mut self, from: usize, delta: isize, cols: usize) {
        if self.extra.is_empty() {
            return;
        }
        self.extra.retain_mut(|(c, _)| {
            let col = *c as usize;
            if col < from {
                return true;
            }
            let moved = col as isize + delta;
            if moved < from as isize || moved >= cols as isize {
                return false;
            }
            *c = moved as u16;
            true
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cell_stays_small() {
        assert!(std::mem::size_of::<Cell>() <= 20, "Cell grew to {} bytes", std::mem::size_of::<Cell>());
    }
}
