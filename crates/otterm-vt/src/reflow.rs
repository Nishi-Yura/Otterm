//! Rewrapping lines for a new width (issue #2).
//!
//! Rows that end in an autowrap ([`Row::wrapped`]) are joined into logical lines, which are then
//! cut again at the new width. Wide characters never straddle a row edge, and combining
//! characters move with their cell.

use crate::cell::{Attrs, Cell, Row};

/// One logical line: the cells of its rows, end to end.
#[derive(Default)]
struct Line {
    cells: Vec<Cell>,
    extra: Vec<(usize, Box<str>)>,
    /// Offset of the cursor in `cells`, if it is on this line. May be past the end.
    cursor: Option<usize>,
}

/// Rewrap `rows` (oldest first) to `cols` columns. `cursor` is (row index, column) in `rows`; the
/// result gives its new position in the returned rows. A column of `cols` means the cursor is
/// right after a full row, waiting to wrap.
pub(crate) fn reflow(rows: Vec<Row>, cols: usize, cursor: (usize, usize)) -> (Vec<Row>, (usize, usize)) {
    let mut out = Vec::with_capacity(rows.len());
    let mut new_cursor = (0, 0);
    // Rows ending in a wrap, collected until the row that ends their logical line.
    let mut run: Vec<Row> = Vec::new();
    let mut run_start = 0;
    for (i, row) in rows.into_iter().enumerate() {
        // Most lines are one row that fits the new width: keep the row as it is. This is what
        // keeps a resize with a full scrollback cheap.
        if run.is_empty() && !row.wrapped && content_len(&row) <= cols && !(i == cursor.0 && cursor.1 >= cols) {
            if i == cursor.0 {
                new_cursor = (out.len(), cursor.1);
            }
            out.push(row);
            continue;
        }
        if run.is_empty() {
            run_start = i;
        }
        let ends_line = !row.wrapped;
        run.push(row);
        if ends_line {
            rewrap(&mut run, run_start, cols, cursor, &mut out, &mut new_cursor);
        }
    }
    if !run.is_empty() {
        rewrap(&mut run, run_start, cols, cursor, &mut out, &mut new_cursor);
    }
    (out, new_cursor)
}

/// Rewrap one logical line made of `run` (rows `start..`) into `out`.
fn rewrap(
    run: &mut Vec<Row>,
    start: usize,
    cols: usize,
    cursor: (usize, usize),
    out: &mut Vec<Row>,
    new_cursor: &mut (usize, usize),
) {
    let local =
        if (start..start + run.len()).contains(&cursor.0) { (cursor.0 - start, cursor.1) } else { (usize::MAX, 0) };
    for line in join(std::mem::take(run), local) {
        if let Some(pos) = split(line, cols, out) {
            *new_cursor = pos;
        }
    }
}

/// Cells up to the last one that is not blank.
fn content_len(row: &Row) -> usize {
    row.cells[..row.used.min(row.cells.len())].iter().rposition(|c| *c != Cell::default()).map_or(0, |n| n + 1)
}

fn join(rows: Vec<Row>, cursor: (usize, usize)) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut line = Line::default();
    let mut rows = rows.into_iter().enumerate().peekable();
    while let Some((i, row)) = rows.next() {
        let base = line.cells.len();
        let mut take = if row.wrapped {
            row.cells.len()
        } else {
            row.cells[..row.used.min(row.cells.len())].iter().rposition(|c| *c != Cell::default()).map_or(0, |n| n + 1)
        };
        // A wide character that did not fit at the end of a row left one blank cell before the
        // wrap; that blank is padding, not text.
        if row.wrapped
            && take > 0
            && row.cells[take - 1] == Cell::default()
            && rows.peek().is_some_and(|(_, next)| next.cells.first().is_some_and(Cell::is_wide))
        {
            take -= 1;
        }
        if i == cursor.0 {
            line.cursor = Some(base + cursor.1);
        }
        line.cells.extend_from_slice(&row.cells[..take]);
        line.extra
            .extend(row.extra.into_iter().filter(|(c, _)| (*c as usize) < take).map(|(c, s)| (base + c as usize, s)));
        if !row.wrapped {
            lines.push(std::mem::take(&mut line));
        }
    }
    if !line.cells.is_empty() || line.cursor.is_some() {
        lines.push(line);
    }
    lines
}

/// Append the rows of one logical line to `out`; returns the cursor position if it is on it.
fn split(line: Line, cols: usize, out: &mut Vec<Row>) -> Option<(usize, usize)> {
    let blank = Attrs::default();
    let mut row = Row::new(cols, &blank);
    let mut col = 0;
    let mut cursor = None;
    let mut extra = line.extra.into_iter().peekable();
    let mut i = 0;
    while i < line.cells.len() {
        let cell = line.cells[i];
        let width = if cell.is_wide() && cols >= 2 { 2 } else { 1 };
        if col + width > cols {
            row.wrapped = true;
            out.push(std::mem::replace(&mut row, Row::new(cols, &blank)));
            col = 0;
        }
        if line.cursor == Some(i) || (width == 2 && line.cursor == Some(i + 1)) {
            cursor = Some((out.len(), col));
        }
        if width == 2 {
            row.cells[col] = cell;
            row.cells[col + 1] = line.cells.get(i + 1).copied().filter(Cell::is_spacer).unwrap_or(cell_spacer(&cell));
        } else if cell.is_spacer() {
            // A spacer whose wide character was cut off earlier.
            row.cells[col] = Cell::default();
        } else {
            row.cells[col] =
                Cell { attrs: Attrs { flags: cell.attrs.flags & !crate::flags::WIDE, ..cell.attrs }, ..cell };
        }
        while extra.peek().is_some_and(|(c, _)| *c < i + width) {
            let (c, s) = extra.next().expect("peeked");
            if c == i {
                row.extra.push((col as u16, s));
            }
        }
        col += width;
        row.touch_to(col);
        // A wide cell consumes its spacer in `line.cells`.
        i += if width == 2 && line.cells.get(i + 1).is_some_and(Cell::is_spacer) { 2 } else { 1 };
    }
    // The cursor sits past the text (after a prompt, or at the end of typed input).
    if let Some(at) = line.cursor.filter(|&at| at >= line.cells.len()) {
        let mut target = col + (at - line.cells.len());
        // Right after a full row the cursor waits past its last column (pending wrap); report
        // column `cols` and let the caller set the wrap flag.
        let pending = target == cols && at == line.cells.len();
        while target >= cols && !pending {
            row.wrapped = true;
            out.push(std::mem::replace(&mut row, Row::new(cols, &blank)));
            target -= cols;
        }
        cursor = Some((out.len(), target));
    }
    out.push(row);
    cursor
}

fn cell_spacer(wide: &Cell) -> Cell {
    Cell { ch: ' ', attrs: Attrs { flags: crate::flags::WIDE_SPACER, ..wide.attrs } }
}
