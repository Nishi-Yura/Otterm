//! Binary screen diffs for the renderer (docs/09-performance.md §3.3, decision M2).
//!
//! All integers are little-endian. One frame:
//!
//! ```text
//! u8   kind = 1
//! u32  session id
//! u16  cols, u16 rows
//! u16  cursor row, u16 cursor col
//! u8   cursor: bit0 visible, bit1 blink, bits2-3 shape (0 block, 1 underline, 2 bar)
//! u8   flags: bit0 full (every row follows), bit1 alternate screen,
//!             bits2-3 mouse tracking (0 off, 1 click, 2 drag, 3 any motion)
//! u64  line number of row 0 (see `Terminal::line`); rows are viewport rows
//! u32  scrollback length in lines
//! u32  view offset: how many lines the view is scrolled up from the bottom (0 = live screen)
//! u16  attribute count, then per attribute:
//!        u32 fg, u32 bg, u32 underline color, u16 flags   (see `encode_color`),
//!        u16 hyperlink id (0 none)
//! u16  row count, then per row:
//!        u16 row index
//!        u8  bit0 wrapped
//!        u16 cell count (trailing default cells are omitted; missing cells are blank)
//!        per cell: u32 code point, u16 attribute index
//!        u16 extra count, then per extra: u16 col, u16 byte length, UTF-8 bytes
//! u16  link count, then per link used by the attributes above: u16 id, u16 byte length, UTF-8 URI
//! ```
//!
//! Wide characters occupy two cells: the character, then a spacer (code point 0x20 with the
//! `WIDE_SPACER` flag in its attributes).
//!
//! While the view is scrolled up, every change sends the whole view; the cursor row is in view
//! coordinates and the cursor is marked invisible when it is below the view.

use std::collections::HashMap;

use crate::cell::{Attrs, Cell, Color, Row};
use crate::term::{CursorShape, MouseMode, Terminal};

pub const FRAME: u8 = 1;

/// Packs a color into a u32: `0` default, `0x01_00_00_nn` indexed, `0x02_rr_gg_bb` RGB.
pub fn encode_color(c: Color) -> u32 {
    match c {
        Color::Default => 0,
        Color::Indexed(n) => 0x0100_0000 | n as u32,
        Color::Rgb(r, g, b) => 0x0200_0000 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
    }
}

/// What the last frame of a session showed, to tell what changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FrameState {
    sent: bool,
    cursor: (usize, usize, u8),
    top: u64,
    offset: usize,
    mouse: u8,
}

/// Append a frame with the rows damaged since the last call, for a view scrolled `offset` lines up
/// from the bottom (clamped to the scrollback). Returns `false` (and appends nothing) when nothing
/// changed.
pub fn encode_frame(
    term: &mut Terminal,
    session: u32,
    offset: usize,
    last: &mut FrameState,
    out: &mut Vec<u8>,
) -> bool {
    let damage = term.take_damage();
    let offset = offset.min(term.scrollback().len());
    let top = term.screen_top() - offset as u64;
    let cursor = term.cursor();
    let modes = term.modes();
    let shape = match modes.cursor_shape {
        CursorShape::Block => 0,
        CursorShape::Underline => 1,
        CursorShape::Bar => 2,
    };
    let cursor_row = cursor.row + offset;
    let visible = modes.cursor_visible && cursor_row < term.rows();
    let cursor_bits = visible as u8 | (modes.cursor_blink as u8) << 1 | shape << 2;
    let mouse = match modes.mouse {
        MouseMode::Off => 0,
        MouseMode::Click => 1,
        MouseMode::Drag => 2,
        MouseMode::Motion => 3,
    };
    let state = FrameState { sent: true, cursor: (cursor_row, cursor.col, cursor_bits), top, offset, mouse };
    let changed = damage.full || !damage.rows.is_empty();
    if !changed && *last == state {
        return false;
    }
    // A scrolled view moves as a whole; send all of it.
    let full = damage.full || offset > 0 && (changed || last.top != top) || last.offset != offset || !last.sent;
    *last = state;

    let rows: Vec<usize> = if full { (0..term.rows()).collect() } else { damage.rows };
    let lines: Vec<&Row> = rows.iter().map(|&r| term.line(top + r as u64).expect("view is inside history")).collect();

    // Attribute table for the rows in this frame.
    let mut attr_index: HashMap<Attrs, u16> = HashMap::new();
    let mut attrs: Vec<Attrs> = Vec::new();
    for row in &lines {
        for cell in &row.cells[..used_len(row)] {
            attr_index.entry(cell.attrs).or_insert_with(|| {
                attrs.push(cell.attrs);
                (attrs.len() - 1) as u16
            });
        }
    }

    out.reserve(32 + attrs.len() * 14 + rows.len() * 8);
    out.push(FRAME);
    out.extend_from_slice(&session.to_le_bytes());
    put_u16(out, term.cols());
    put_u16(out, term.rows());
    put_u16(out, cursor_row.min(u16::MAX as usize));
    put_u16(out, cursor.col);
    out.push(cursor_bits);
    out.push(full as u8 | (modes.alt_screen as u8) << 1 | mouse << 2);
    out.extend_from_slice(&top.to_le_bytes());
    out.extend_from_slice(&(term.scrollback().len() as u32).to_le_bytes());
    out.extend_from_slice(&(offset as u32).to_le_bytes());

    put_u16(out, attrs.len());
    for a in &attrs {
        out.extend_from_slice(&encode_color(a.fg).to_le_bytes());
        out.extend_from_slice(&encode_color(a.bg).to_le_bytes());
        out.extend_from_slice(&encode_color(a.underline_color).to_le_bytes());
        out.extend_from_slice(&a.flags.to_le_bytes());
        out.extend_from_slice(&a.link.to_le_bytes());
    }

    put_u16(out, rows.len());
    for (&r, row) in rows.iter().zip(&lines) {
        let n = used_len(row);
        put_u16(out, r);
        out.push(row.wrapped as u8);
        put_u16(out, n);
        out.reserve(n * 6);
        for cell in &row.cells[..n] {
            out.extend_from_slice(&(cell.ch as u32).to_le_bytes());
            out.extend_from_slice(&attr_index[&cell.attrs].to_le_bytes());
        }
        put_u16(out, row.extra.len());
        for (col, text) in &row.extra {
            out.extend_from_slice(&col.to_le_bytes());
            put_u16(out, text.len());
            out.extend_from_slice(text.as_bytes());
        }
    }
    // Targets of the hyperlinks in this frame's attributes.
    let mut ids: Vec<u16> = attrs.iter().map(|a| a.link).filter(|&id| id != 0).collect();
    ids.sort_unstable();
    ids.dedup();
    let links: Vec<(u16, &str)> = ids.into_iter().filter_map(|id| Some((id, term.link(id)?))).collect();
    put_u16(out, links.len());
    for (id, uri) in links {
        out.extend_from_slice(&id.to_le_bytes());
        put_u16(out, uri.len());
        out.extend_from_slice(uri.as_bytes());
    }
    true
}

/// Cells up to the last non-default one.
fn used_len(row: &Row) -> usize {
    row.cells[..row.used].iter().rposition(|c| *c != Cell::default()).map_or(0, |i| i + 1)
}

fn put_u16(out: &mut Vec<u8>, v: usize) {
    out.extend_from_slice(&(v as u16).to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Reader<'a>(&'a [u8]);
    impl Reader<'_> {
        fn u8(&mut self) -> u8 {
            let v = self.0[0];
            self.0 = &self.0[1..];
            v
        }
        fn u16(&mut self) -> u16 {
            let v = u16::from_le_bytes([self.0[0], self.0[1]]);
            self.0 = &self.0[2..];
            v
        }
        fn u32(&mut self) -> u32 {
            let v = u32::from_le_bytes(self.0[..4].try_into().unwrap());
            self.0 = &self.0[4..];
            v
        }
        fn u64(&mut self) -> u64 {
            let v = u64::from_le_bytes(self.0[..8].try_into().unwrap());
            self.0 = &self.0[8..];
            v
        }
        /// Skip to the rows of a frame; returns (full, top line, scrollback, offset, cursor row).
        fn header(&mut self) -> (bool, u64, u32, u32, u16) {
            assert_eq!(self.u8(), FRAME);
            self.u32();
            self.u16();
            self.u16();
            let cursor_row = self.u16();
            self.u16();
            self.u8();
            let full = self.u8() & 1 == 1;
            let view = (self.u64(), self.u32(), self.u32());
            let n_attrs = self.u16() as usize;
            self.0 = &self.0[n_attrs * 16..];
            (full, view.0, view.1, view.2, cursor_row)
        }
    }

    #[test]
    fn full_frame_then_only_damaged_rows() {
        let mut t = Terminal::new(4, 3);
        t.advance("\x1b[31mab\x1b[0m日".as_bytes());
        let mut out = Vec::new();
        let mut last = FrameState::default();
        assert!(encode_frame(&mut t, 7, 0, &mut last, &mut out));

        let mut r = Reader(&out);
        assert_eq!(r.u8(), FRAME);
        assert_eq!(r.u32(), 7);
        assert_eq!((r.u16(), r.u16()), (4, 3));
        assert_eq!((r.u16(), r.u16()), (0, 3));
        assert_eq!(r.u8() & 1, 1, "cursor visible");
        assert_eq!(r.u8() & 1, 1, "first frame is full");
        assert_eq!((r.u64(), r.u32(), r.u32()), (0, 0, 0), "live view, no scrollback");
        let n_attrs = r.u16();
        let mut fgs = Vec::new();
        for _ in 0..n_attrs {
            fgs.push(r.u32());
            r.u32();
            r.u32();
            r.u16();
            r.u16();
        }
        assert_eq!(r.u16(), 3, "all rows");
        assert_eq!(r.u16(), 0);
        assert_eq!(r.u8(), 0);
        assert_eq!(r.u16(), 4, "a b 日 spacer");
        let a = (r.u32(), r.u16());
        assert_eq!(a.0, 'a' as u32);
        assert_eq!(fgs[a.1 as usize], 0x0100_0001);
        r.u32();
        r.u16();
        assert_eq!(r.u32(), '日' as u32);
        r.u16();
        assert_eq!(r.u32(), ' ' as u32);
        r.u16();
        assert_eq!(r.u16(), 0, "no extras");
        assert_eq!((r.u16(), r.u8(), r.u16(), r.u16()), (1, 0, 0, 0), "blank row");

        // Nothing changed: no frame.
        out.clear();
        assert!(!encode_frame(&mut t, 7, 0, &mut last, &mut out));
        assert!(out.is_empty());

        // One row changed: only that row.
        t.advance(b"\x1b[3;1Hz");
        assert!(encode_frame(&mut t, 7, 0, &mut last, &mut out));
        let mut r = Reader(&out);
        assert!(!r.header().0, "not full");
        assert_eq!(r.u16(), 1);
        assert_eq!(r.u16(), 2, "row index");
    }

    #[test]
    fn cursor_move_alone_sends_a_frame_without_rows() {
        let mut t = Terminal::new(4, 2);
        let mut out = Vec::new();
        let mut last = FrameState::default();
        encode_frame(&mut t, 1, 0, &mut last, &mut out);
        out.clear();
        t.advance(b"\x1b[2;2H");
        assert!(encode_frame(&mut t, 1, 0, &mut last, &mut out));
        assert_eq!(&out[out.len() - 2..], &[0, 0], "zero rows");
    }

    #[test]
    fn scrolled_view_shows_history_and_moves_the_cursor_out() {
        let mut t = Terminal::new(4, 2);
        t.advance(b"a\r\nb\r\nc\r\nd");
        let mut out = Vec::new();
        let mut last = FrameState::default();
        encode_frame(&mut t, 1, 0, &mut last, &mut out);

        // Scrolled up 2: the view shows "a" and "b" from scrollback; the cursor is below it.
        out.clear();
        assert!(encode_frame(&mut t, 1, 2, &mut last, &mut out));
        let mut r = Reader(&out);
        let (full, top, scrollback, offset, cursor_row) = r.header();
        assert!(full);
        assert_eq!((top, scrollback, offset, cursor_row), (0, 2, 2, 3));
        assert_eq!(out[13] & 1, 0, "cursor hidden below the view");
        assert_eq!(r.u16(), 2, "both rows");
        assert_eq!((r.u16(), r.u8(), r.u16(), r.u32()), (0, 0, 1, 'a' as u32));

        // New output while scrolled: the whole view is sent again.
        out.clear();
        t.advance(b"\r\ne");
        assert!(encode_frame(&mut t, 1, 2, &mut last, &mut out));
        assert!(Reader(&out).header().0);

        // An offset past the scrollback is clamped.
        out.clear();
        encode_frame(&mut t, 1, 99, &mut last, &mut out);
        assert_eq!(Reader(&out).header().3, 3);
    }

    #[test]
    fn colors_pack() {
        assert_eq!(encode_color(Color::Default), 0);
        assert_eq!(encode_color(Color::Indexed(200)), 0x0100_00c8);
        assert_eq!(encode_color(Color::Rgb(1, 2, 3)), 0x0201_0203);
    }
}
