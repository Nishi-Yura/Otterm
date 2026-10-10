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
//! u8   flags: bit0 full (every row follows), bit1 alternate screen
//! u16  attribute count, then per attribute:
//!        u32 fg, u32 bg, u32 underline color, u16 flags   (see `encode_color`)
//! u16  row count, then per row:
//!        u16 row index
//!        u8  bit0 wrapped
//!        u16 cell count (trailing default cells are omitted; missing cells are blank)
//!        per cell: u32 code point, u16 attribute index
//!        u16 extra count, then per extra: u16 col, u16 byte length, UTF-8 bytes
//! ```
//!
//! Wide characters occupy two cells: the character, then a spacer (code point 0x20 with the
//! `WIDE_SPACER` flag in its attributes).

use std::collections::HashMap;

use crate::cell::{Attrs, Cell, Color, Row};
use crate::term::{CursorShape, Terminal};

pub const FRAME: u8 = 1;

/// Packs a color into a u32: `0` default, `0x01_00_00_nn` indexed, `0x02_rr_gg_bb` RGB.
pub fn encode_color(c: Color) -> u32 {
    match c {
        Color::Default => 0,
        Color::Indexed(n) => 0x0100_0000 | n as u32,
        Color::Rgb(r, g, b) => 0x0200_0000 | (r as u32) << 16 | (g as u32) << 8 | b as u32,
    }
}

/// Append a frame with the rows damaged since the last call. Returns `false` (and appends nothing)
/// when nothing changed and the cursor did not move.
pub fn encode_frame(
    term: &mut Terminal,
    session: u32,
    last_cursor: &mut Option<(usize, usize, u8)>,
    out: &mut Vec<u8>,
) -> bool {
    let damage = term.take_damage();
    let cursor = term.cursor();
    let modes = term.modes();
    let shape = match modes.cursor_shape {
        CursorShape::Block => 0,
        CursorShape::Underline => 1,
        CursorShape::Bar => 2,
    };
    let cursor_bits = modes.cursor_visible as u8 | (modes.cursor_blink as u8) << 1 | shape << 2;
    let cursor_state = (cursor.row, cursor.col, cursor_bits);
    if !damage.full && damage.rows.is_empty() && *last_cursor == Some(cursor_state) {
        return false;
    }
    *last_cursor = Some(cursor_state);

    let screen = term.screen();
    let rows: Vec<usize> = if damage.full { (0..term.rows()).collect() } else { damage.rows };

    // Attribute table for the rows in this frame.
    let mut attr_index: HashMap<Attrs, u16> = HashMap::new();
    let mut attrs: Vec<Attrs> = Vec::new();
    for &r in &rows {
        for cell in &screen[r].cells[..used_len(&screen[r])] {
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
    put_u16(out, cursor.row);
    put_u16(out, cursor.col);
    out.push(cursor_bits);
    out.push(damage.full as u8 | (modes.alt_screen as u8) << 1);

    put_u16(out, attrs.len());
    for a in &attrs {
        out.extend_from_slice(&encode_color(a.fg).to_le_bytes());
        out.extend_from_slice(&encode_color(a.bg).to_le_bytes());
        out.extend_from_slice(&encode_color(a.underline_color).to_le_bytes());
        out.extend_from_slice(&a.flags.to_le_bytes());
    }

    put_u16(out, rows.len());
    for &r in &rows {
        let row = &screen[r];
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
    }

    #[test]
    fn full_frame_then_only_damaged_rows() {
        let mut t = Terminal::new(4, 3);
        t.advance("\x1b[31mab\x1b[0m日".as_bytes());
        let mut out = Vec::new();
        let mut cursor = None;
        assert!(encode_frame(&mut t, 7, &mut cursor, &mut out));

        let mut r = Reader(&out);
        assert_eq!(r.u8(), FRAME);
        assert_eq!(r.u32(), 7);
        assert_eq!((r.u16(), r.u16()), (4, 3));
        assert_eq!((r.u16(), r.u16()), (0, 3));
        assert_eq!(r.u8() & 1, 1, "cursor visible");
        assert_eq!(r.u8() & 1, 1, "first frame is full");
        let n_attrs = r.u16();
        let mut fgs = Vec::new();
        for _ in 0..n_attrs {
            fgs.push(r.u32());
            r.u32();
            r.u32();
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
        assert!(!encode_frame(&mut t, 7, &mut cursor, &mut out));
        assert!(out.is_empty());

        // One row changed: only that row.
        t.advance(b"\x1b[3;1Hz");
        assert!(encode_frame(&mut t, 7, &mut cursor, &mut out));
        let mut r = Reader(&out[14..]);
        assert_eq!(r.u8() & 1, 0, "not full");
        let n_attrs = r.u16();
        r.0 = &r.0[n_attrs as usize * 14..];
        assert_eq!(r.u16(), 1);
        assert_eq!(r.u16(), 2, "row index");
    }

    #[test]
    fn cursor_move_alone_sends_a_frame_without_rows() {
        let mut t = Terminal::new(4, 2);
        let mut out = Vec::new();
        let mut cursor = None;
        encode_frame(&mut t, 1, &mut cursor, &mut out);
        out.clear();
        t.advance(b"\x1b[2;2H");
        assert!(encode_frame(&mut t, 1, &mut cursor, &mut out));
        assert_eq!(&out[out.len() - 2..], &[0, 0], "zero rows");
    }

    #[test]
    fn colors_pack() {
        assert_eq!(encode_color(Color::Default), 0);
        assert_eq!(encode_color(Color::Indexed(200)), 0x0100_00c8);
        assert_eq!(encode_color(Color::Rgb(1, 2, 3)), 0x0201_0203);
    }
}
