//! VT parsing and the terminal grid. Spec: docs/03-core-features.md §2, docs/09-performance.md §3.5.
//!
//! [`Terminal`] takes PTY output through [`Terminal::advance`] and keeps the visible screen, the
//! scrollback, the cursor and the modes. The host reads damage, responses (bytes to write back to
//! the PTY) and events after each call.

mod cell;
pub mod diff;
mod input;
mod reflow;
pub mod search;
mod term;

pub use cell::{Attrs, BlockHead, BlockState, Cell, Color, Row, flags};
pub use input::{Key, Mouse, MouseAction, MouseButton, encode_key, encode_mouse, encode_paste};
pub use term::{BlockRange, Cursor, CursorShape, Damage, Event, KITTY_SUPPORTED, Modes, MouseMode, Terminal};
