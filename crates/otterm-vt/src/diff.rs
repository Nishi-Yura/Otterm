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
//! u8   block of row 0 (the newest head at or above it): 0 none, 1 at its prompt, 2 running,
//!      3 ended with 0, 4 ended with another code
//! u16  attribute count, then per attribute:
//!        u32 fg, u32 bg, u32 underline color, u16 flags   (see `encode_color`),
//!        u16 hyperlink id (0 none)
//! u16  row count, then per row:
//!        u16 row index
//!        u8  bit0 wrapped, bit1 a block starts here (docs/03 §6.3)
//!        u16 cell count (trailing default cells are omitted; missing cells are blank)
//!        per cell: u32 code point, u16 attribute index
//!        u16 extra count, then per extra: u16 col, u16 byte length, UTF-8 bytes
//!        with bit1: u8 state (0 prompt, 1 input, 2 running, 3 done),
//!                   u16 byte length, prompt bar info (base64 JSON, decision M4; empty when the
//!                   shell prints its own prompt on this row),
//!                   u16 byte length, command line (UTF-8; empty until entered),
//!                   with state 3: i32 exit code, u32 duration in ms
//! u16  link count, then per link used by the attributes above: u16 id, u16 byte length, UTF-8 URI
//! ```
//!
//! Wide characters occupy two cells: the character, then a spacer (code point 0x20 with the
//! `WIDE_SPACER` flag in its attributes).
//!
//! While the view is scrolled up, every change sends the whole view; the cursor row is in view
//! coordinates and the cursor is marked invisible when it is below the view.

use std::collections::HashMap;

use crate::cell::{Attrs, BlockState, Cell, Color, Row};
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
    out.push(match term.block_head_at(top).map(|(_, h)| h.state) {
        None => 0,
        Some(BlockState::Prompt | BlockState::Input) => 1,
        Some(BlockState::Running) => 2,
        Some(BlockState::Done { exit: 0, .. }) => 3,
        Some(BlockState::Done { .. }) => 4,
    });

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
        let block = row.block.as_deref();
        out.push(row.wrapped as u8 | (block.is_some() as u8) << 1);
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
        if let Some(block) = block {
            out.push(match block.state {
                BlockState::Prompt => 0,
                BlockState::Input => 1,
                BlockState::Running => 2,
                BlockState::Done { .. } => 3,
            });
            put_u16(out, block.info.len());
            out.extend_from_slice(block.info.as_bytes());
            let command = block.command.as_deref().unwrap_or_default();
            put_u16(out, command.len());
            out.extend_from_slice(command.as_bytes());
            if let BlockState::Done { exit, ms } = block.state {
                out.extend_from_slice(&exit.to_le_bytes());
                out.extend_from_slice(&ms.to_le_bytes());
            }
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
