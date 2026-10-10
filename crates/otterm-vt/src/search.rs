//! Searching the scrollback and the screen (docs/03 §4).
//!
//! Rows joined by autowrap are searched as one line, so a match can run across a row edge.
//! Positions are (line number, column) as in [`Terminal::line`].

use regex::{Regex, RegexBuilder};

use crate::term::Terminal;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SearchOptions {
    /// The query is a regular expression rather than plain text.
    pub regex: bool,
    pub case_sensitive: bool,
    pub whole_word: bool,
}

/// A match from its first cell to its last cell, inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Match {
    pub start: (u64, usize),
    pub end: (u64, usize),
}

/// Compile a query. Errors are for the user (an invalid regular expression).
pub fn compile(query: &str, opts: SearchOptions) -> Result<Regex, String> {
    let pattern = if opts.regex { query.to_owned() } else { regex::escape(query) };
    let pattern = if opts.whole_word { format!(r"\b(?:{pattern})\b") } else { pattern };
    RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| e.to_string())
}

/// Every match of `re`, oldest first, at most `limit`. Empty matches are skipped.
pub fn search(term: &Terminal, re: &Regex, limit: usize) -> Vec<Match> {
    let mut out = Vec::new();
    let first = term.history_base();
    let end = term.screen_top() + term.rows() as u64;
    let mut line = first;
    while line < end && out.len() < limit {
        let (text, cells, next) = logical_line(term, line, end);
        for m in re.find_iter(&text) {
            if m.is_empty() {
                continue;
            }
            let start = cell_at(&cells, m.start());
            let last = cell_at(&cells, m.end() - 1);
            out.push(Match { start: (start.0, start.1), end: (last.0, last.1 + last.2 - 1) });
            if out.len() == limit {
                break;
            }
        }
        line = next;
    }
    out
}

/// Where each character of a logical line came from: (byte offset, line, column, width).
type CellMap = Vec<(usize, u64, usize, usize)>;

/// The text of the logical line starting at `line`, its cell map, and the line after it.
fn logical_line(term: &Terminal, mut line: u64, end: u64) -> (String, CellMap, u64) {
    let mut text = String::new();
    let mut cells = Vec::new();
    while line < end {
        let Some(row) = term.line(line) else { break };
        let mut col = 0;
        while col < row.cells.len() {
            let cell = &row.cells[col];
            let width = if cell.is_wide() { 2 } else { 1 };
            if !cell.is_spacer() {
                cells.push((text.len(), line, col, width));
                text.push_str(&row.cell_text(col));
            }
            col += width;
        }
        line += 1;
        if !row.wrapped {
            // Trailing blanks are not text; trim them and their cells.
            let trimmed = text.trim_end_matches(' ').len();
            text.truncate(trimmed);
            while cells.last().is_some_and(|c| c.0 >= trimmed) {
                cells.pop();
            }
            break;
        }
    }
    (text, cells, line)
}

/// The cell holding byte `offset`: (line, column, width).
fn cell_at(cells: &CellMap, offset: usize) -> (u64, usize, usize) {
    let i = cells.partition_point(|c| c.0 <= offset).saturating_sub(1);
    let c = cells[i];
    (c.1, c.2, c.3)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn find(t: &Terminal, q: &str, opts: SearchOptions) -> Vec<Match> {
        search(t, &compile(q, opts).unwrap(), 100)
    }

    #[test]
    fn plain_text_ignores_case_by_default() {
        let mut t = Terminal::new(10, 3);
        t.advance(b"Error one\r\nno error\r\nERROR");
        let m = find(&t, "error", SearchOptions::default());
        let starts: Vec<_> = m.iter().map(|m| m.start).collect();
        assert_eq!(starts, [(0, 0), (1, 3), (2, 0)]);
        assert_eq!(m[0].end, (0, 4));
        assert_eq!(find(&t, "error", SearchOptions { case_sensitive: true, ..Default::default() }).len(), 1);
    }

    #[test]
    fn matches_cross_wrapped_rows_and_wide_characters() {
        let mut t = Terminal::new(6, 3);
        t.advance("abcdefgh\r\n日本語です".as_bytes());
        // "efg" runs from row 0 into row 1.
        let m = find(&t, "efg", SearchOptions::default());
        assert_eq!(m, [Match { start: (0, 4), end: (1, 0) }]);
        // A wide character covers two cells.
        let m = find(&t, "本語", SearchOptions::default());
        assert_eq!(m, [Match { start: (2, 2), end: (2, 5) }]);
    }

    #[test]
    fn scrollback_is_searched_and_regex_and_words_work() {
        let mut t = Terminal::new(20, 2);
        t.advance(b"cat catalog\r\ndog\r\nlast");
        assert_eq!(t.scrollback().len(), 1);
        let m = find(&t, "cat", SearchOptions { whole_word: true, ..Default::default() });
        assert_eq!(m, [Match { start: (0, 0), end: (0, 2) }]);
        let m = find(&t, r"d\wg", SearchOptions { regex: true, ..Default::default() });
        assert_eq!(m[0].start, (1, 0));
        assert!(compile("(", SearchOptions { regex: true, ..Default::default() }).is_err());
        // Plain text is literal.
        assert!(find(&t, "d.g", SearchOptions::default()).is_empty());
    }
}
