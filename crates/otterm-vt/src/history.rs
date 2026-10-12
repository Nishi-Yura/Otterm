//! The scrollback (docs/09 §5): recent lines as rows, older lines in chunks of [`CHUNK`] rows
//! compressed with LZ4, and — when the user asked for unlimited scrollback — the oldest chunks in
//! files on disk, up to `terminal.scrollback_spill_limit_mb`.
//!
//! Only the newest [`HOT_ROWS`] lines are kept as rows: they are what reflow, block heads that are
//! still being written, and the usual scrolling touch. A compressed chunk is decompressed when a
//! line in it is read (searching, scrolling far up) and the last one is kept decoded, so reading
//! along a chunk does not decompress it again.
//!
//! Lines are dropped from the front a chunk at a time, so the scrollback may hold up to
//! `CHUNK - 1` lines more than its limit. Block heads are kept beside a chunk, not compressed:
//! there are few of them and the UI looks them up often.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use crate::cell::{Attrs, BlockHead, Cell, Color, Row};

/// Lines per compressed chunk.
pub const CHUNK: usize = 1024;
/// Lines kept as plain rows at the newest end.
pub const HOT_ROWS: usize = 4096;
/// Compressed chunks kept in memory before the oldest go to disk (only with a spill folder).
const MEM_BUDGET: usize = 32 * 1024 * 1024;

/// Where chunks go once memory holds [`MEM_BUDGET`] of them, and how much they may take.
#[derive(Debug, Clone)]
pub struct Spill {
    pub dir: PathBuf,
    pub limit_bytes: u64,
}

#[derive(Debug)]
enum Data {
    Mem(Vec<u8>),
    Disk { path: PathBuf, len: u64 },
}

#[derive(Debug)]
struct Chunk {
    id: u64,
    rows: usize,
    data: Data,
    /// Block heads by row index within the chunk.
    heads: Vec<(usize, Box<BlockHead>)>,
}

#[derive(Debug, Default)]
pub struct History {
    cold: VecDeque<Chunk>,
    cold_rows: usize,
    hot: VecDeque<Row>,
    mem_bytes: usize,
    spill: Option<Spill>,
    disk_bytes: u64,
    next_id: u64,
    /// The chunk decoded last, by id.
    cache: RefCell<Option<(u64, Arc<Vec<Row>>)>>,
}

impl History {
    pub fn len(&self) -> usize {
        self.cold_rows + self.hot.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Spill old chunks to `spill.dir` from now on (`None`: keep everything in memory).
    pub fn set_spill(&mut self, spill: Option<Spill>) -> usize {
        self.spill = spill;
        self.enforce_budget()
    }

    pub fn spill(&self) -> Option<Spill> {
        self.spill.clone()
    }

    /// Line `i`, counting from the oldest kept line.
    pub fn get(&self, i: usize) -> Option<Cow<'_, Row>> {
        if let Some(h) = i.checked_sub(self.cold_rows) {
            return self.hot.get(h).map(Cow::Borrowed);
        }
        let (chunk, at) = self.locate(i)?;
        let rows = self.decoded(chunk)?;
        let mut row = rows.get(at)?.clone();
        row.block = chunk.heads.iter().find(|(j, _)| *j == at).map(|(_, h)| h.clone());
        Some(Cow::Owned(row))
    }

    /// The chunk holding cold line `i`, and the row's index in it.
    fn locate(&self, mut i: usize) -> Option<(&Chunk, usize)> {
        for c in &self.cold {
            if i < c.rows {
                return Some((c, i));
            }
            i -= c.rows;
        }
        None
    }

    fn decoded(&self, chunk: &Chunk) -> Option<Arc<Vec<Row>>> {
        if let Some((id, rows)) = self.cache.borrow().as_ref()
            && *id == chunk.id
        {
            return Some(Arc::clone(rows));
        }
        let bytes = match &chunk.data {
            Data::Mem(b) => Cow::Borrowed(b.as_slice()),
            Data::Disk { path, .. } => Cow::Owned(std::fs::read(path).ok()?),
        };
        let raw = lz4_flex::decompress_size_prepended(&bytes).ok()?;
        let rows = Arc::new(decode_rows(&raw)?);
        *self.cache.borrow_mut() = Some((chunk.id, Arc::clone(&rows)));
        Some(rows)
    }

    /// Add the newest line. Returns how many of the oldest lines were dropped to stay within the
    /// spill limit (the caller moves its line numbers on by that much).
    pub fn push_back(&mut self, row: Row) -> usize {
        self.hot.push_back(row);
        if self.hot.len() < HOT_ROWS + CHUNK {
            return 0;
        }
        let rows: Vec<Row> = self.hot.drain(..CHUNK).collect();
        self.freeze(rows);
        self.enforce_budget()
    }

    /// Compress `rows` into a new chunk at the newest end of the cold part.
    fn freeze(&mut self, mut rows: Vec<Row>) {
        let heads = rows.iter_mut().enumerate().filter_map(|(i, r)| Some((i, r.block.take()?))).collect();
        let data = lz4_flex::compress_prepend_size(&encode_rows(&rows));
        self.mem_bytes += data.len();
        self.cold_rows += rows.len();
        self.cold.push_back(Chunk { id: self.next_id, rows: rows.len(), data: Data::Mem(data), heads });
        self.next_id += 1;
    }

    /// Move chunks to disk past the memory budget, and drop the oldest past the disk limit.
    fn enforce_budget(&mut self) -> usize {
        let Some(spill) = self.spill.clone() else { return 0 };
        while self.mem_bytes > MEM_BUDGET {
            let Some(chunk) = self.cold.iter_mut().find(|c| matches!(c.data, Data::Mem(_))) else { break };
            let Data::Mem(bytes) = &chunk.data else { break };
            let path = spill.dir.join(format!("{}.lz4", chunk.id));
            if std::fs::create_dir_all(&spill.dir).is_err() || std::fs::write(&path, bytes).is_err() {
                // No disk: keep it in memory rather than lose it.
                break;
            }
            let len = bytes.len() as u64;
            self.mem_bytes -= bytes.len();
            self.disk_bytes += len;
            chunk.data = Data::Disk { path, len };
        }
        let mut dropped = 0;
        while self.disk_bytes > spill.limit_bytes {
            match self.cold.front() {
                Some(c) if matches!(c.data, Data::Disk { .. }) => dropped += self.drop_chunk(),
                _ => break,
            }
        }
        dropped
    }

    fn drop_chunk(&mut self) -> usize {
        let Some(c) = self.cold.pop_front() else { return 0 };
        self.cold_rows -= c.rows;
        match c.data {
            Data::Mem(b) => self.mem_bytes -= b.len(),
            Data::Disk { path, len } => {
                let _ = std::fs::remove_file(path);
                self.disk_bytes -= len;
            }
        }
        c.rows
    }

    /// Take back the newest line (the screen grew).
    pub fn pop_back(&mut self) -> Option<Row> {
        if self.hot.is_empty() {
            self.thaw_last();
        }
        self.hot.pop_back()
    }

    /// Move the newest chunk back into plain rows.
    fn thaw_last(&mut self) {
        let Some(chunk) = self.cold.back() else { return };
        let Some(rows) = self.decoded(chunk) else { return };
        let mut rows: Vec<Row> = rows.as_ref().clone();
        let chunk = self.cold.pop_back().expect("checked above");
        for (i, head) in chunk.heads {
            if let Some(r) = rows.get_mut(i) {
                r.block = Some(head);
            }
        }
        self.cold_rows -= chunk.rows;
        match chunk.data {
            Data::Mem(b) => self.mem_bytes -= b.len(),
            Data::Disk { path, len } => {
                let _ = std::fs::remove_file(path);
                self.disk_bytes -= len;
            }
        }
        for r in rows.into_iter().rev() {
            self.hot.push_front(r);
        }
    }

    /// Drop the oldest lines while more than `limit` are kept: whole chunks from the cold part,
    /// single rows once only plain rows are left. Returns how many lines went.
    pub fn trim_to(&mut self, limit: usize) -> usize {
        let mut dropped = 0;
        while let Some(c) = self.cold.front() {
            if self.len() - c.rows < limit {
                break;
            }
            dropped += self.drop_chunk();
        }
        if self.cold.is_empty() {
            while self.hot.len() > limit {
                self.hot.pop_front();
                dropped += 1;
            }
        }
        dropped
    }

    /// The plain rows at the newest end, for trimming them to a narrower screen.
    pub fn hot_mut(&mut self) -> impl Iterator<Item = &mut Row> {
        self.hot.iter_mut()
    }

    /// Hand the plain rows over for reflow. Compressed chunks keep their old width: rewrapping
    /// all of a long history on every resize would cost more than it gives.
    pub fn take_hot(&mut self) -> Vec<Row> {
        self.hot.drain(..).collect()
    }

    pub fn set_hot(&mut self, rows: Vec<Row>) {
        self.hot = rows.into();
    }

    /// Index of the newest block head among lines `0..upto`.
    pub fn last_head_before(&self, upto: usize) -> Option<usize> {
        let hot_upto = upto.saturating_sub(self.cold_rows).min(self.hot.len());
        if let Some(h) = self.hot.iter().take(hot_upto).rposition(|r| r.block.is_some()) {
            return Some(self.cold_rows + h);
        }
        let mut start = self.cold_rows;
        for c in self.cold.iter().rev() {
            start -= c.rows;
            if let Some((i, _)) = c.heads.iter().rev().find(|(i, _)| start + i < upto) {
                return Some(start + i);
            }
        }
        None
    }

    /// The block head on line `i`, if any.
    pub fn head(&self, i: usize) -> Option<&BlockHead> {
        if let Some(h) = i.checked_sub(self.cold_rows) {
            return self.hot.get(h)?.block.as_deref();
        }
        let mut start = 0;
        for c in &self.cold {
            if i < start + c.rows {
                return c.heads.iter().find(|(j, _)| start + j == i).map(|(_, h)| h.as_ref());
            }
            start += c.rows;
        }
        None
    }

    pub fn head_mut(&mut self, i: usize) -> Option<&mut BlockHead> {
        if let Some(h) = i.checked_sub(self.cold_rows) {
            return self.hot.get_mut(h)?.block.as_deref_mut();
        }
        let mut start = 0;
        for c in &mut self.cold {
            if i < start + c.rows {
                return c.heads.iter_mut().find(|(j, _)| start + *j == i).map(|(_, h)| h.as_mut());
            }
            start += c.rows;
        }
        None
    }

    /// Every block head, oldest first, with its line index.
    pub fn heads(&self) -> impl Iterator<Item = (usize, &BlockHead)> {
        let mut start = 0;
        let cold = self.cold.iter().flat_map(move |c| {
            let base = start;
            start += c.rows;
            c.heads.iter().map(move |(i, h)| (base + i, h.as_ref()))
        });
        let offset = self.cold_rows;
        cold.chain(self.hot.iter().enumerate().filter_map(move |(i, r)| Some((offset + i, r.block.as_deref()?))))
    }

    pub fn clear(&mut self) {
        while !self.cold.is_empty() {
            self.drop_chunk();
        }
        self.hot.clear();
        *self.cache.borrow_mut() = None;
    }
}

impl Drop for History {
    fn drop(&mut self) {
        self.clear();
    }
}

// --- the chunk format: rows as bytes, before LZ4 ---------------------------------------------------

fn put_color(out: &mut Vec<u8>, c: Color) {
    match c {
        Color::Default => out.push(0),
        Color::Indexed(i) => out.extend([1, i]),
        Color::Rgb(r, g, b) => out.extend([2, r, g, b]),
    }
}

fn encode_rows(rows: &[Row]) -> Vec<u8> {
    let mut out = Vec::with_capacity(rows.len() * 32);
    out.extend((rows.len() as u32).to_le_bytes());
    for r in rows {
        out.push(u8::from(r.wrapped));
        out.extend((r.cells.len() as u32).to_le_bytes());
        for c in &r.cells {
            out.extend((c.ch as u32).to_le_bytes());
            put_color(&mut out, c.attrs.fg);
            put_color(&mut out, c.attrs.bg);
            put_color(&mut out, c.attrs.underline_color);
            out.extend(c.attrs.flags.to_le_bytes());
            out.extend(c.attrs.link.to_le_bytes());
        }
        out.extend((r.extra.len() as u16).to_le_bytes());
        for (col, s) in &r.extra {
            out.extend(col.to_le_bytes());
            out.extend((s.len() as u16).to_le_bytes());
            out.extend(s.as_bytes());
        }
    }
    out
}

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Option<&[u8]> {
        let s = self.b.get(self.at..self.at + n)?;
        self.at += n;
        Some(s)
    }
    fn left(&self) -> usize {
        self.b.len().saturating_sub(self.at)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?))
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
    }
    fn color(&mut self) -> Option<Color> {
        Some(match self.u8()? {
            0 => Color::Default,
            1 => Color::Indexed(self.u8()?),
            _ => Color::Rgb(self.u8()?, self.u8()?, self.u8()?),
        })
    }
}

/// Smallest encoded cell: a char, three one-byte colors, flags and link.
const MIN_CELL_BYTES: usize = 4 + 3 + 2 + 2;
/// Smallest encoded row: the wrap flag, the cell count and the extra count.
const MIN_ROW_BYTES: usize = 1 + 4 + 2;

fn decode_rows(b: &[u8]) -> Option<Vec<Row>> {
    let mut r = Reader { b, at: 0 };
    let n = r.u32()? as usize;
    // Lengths are checked against the bytes left before anything is allocated for them.
    if n > r.left() / MIN_ROW_BYTES {
        return None;
    }
    let mut rows = Vec::with_capacity(n);
    for _ in 0..n {
        let wrapped = r.u8()? != 0;
        let cells_n = r.u32()? as usize;
        if cells_n > r.left() / MIN_CELL_BYTES {
            return None;
        }
        let mut cells = Vec::with_capacity(cells_n);
        for _ in 0..cells_n {
            let ch = char::from_u32(r.u32()?).unwrap_or(' ');
            let attrs =
                Attrs { fg: r.color()?, bg: r.color()?, underline_color: r.color()?, flags: r.u16()?, link: r.u16()? };
            cells.push(Cell { ch, attrs });
        }
        let extra_n = r.u16()? as usize;
        let mut extra = Vec::with_capacity(extra_n);
        for _ in 0..extra_n {
            let col = r.u16()?;
            let len = r.u16()? as usize;
            let s = std::str::from_utf8(r.take(len)?).ok()?;
            extra.push((col, s.into()));
        }
        let used = cells.len();
        rows.push(Row { cells, extra, wrapped, block: None, used });
    }
    Some(rows)
}
