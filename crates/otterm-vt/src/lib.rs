//! VT parsing and the terminal grid. Spec: docs/03-core-features.md §2, docs/09-performance.md §3.5.
//!
//! [`Terminal`] takes PTY output through [`Terminal::advance`] and keeps the visible screen, the
//! scrollback, the cursor and the modes. The host reads damage, responses (bytes to write back to
//! the PTY) and events after each call.

mod cell;
pub mod diff;
mod term;

pub use cell::{Attrs, Cell, Color, Row, flags};
pub use term::{Cursor, CursorShape, Damage, Event, Modes, MouseMode, Terminal};
