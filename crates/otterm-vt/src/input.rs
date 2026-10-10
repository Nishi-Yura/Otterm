//! Keyboard and paste input → bytes for the PTY, following the terminal's modes (xterm encoding).
//! Spec: docs/03-core-features.md §2.1, docs/09-performance.md §3.1 (keys go straight to Rust).

use crate::term::Modes;

/// A key press as the UI reports it. `key` uses the DOM `KeyboardEvent.key` names
/// (`"a"`, `"Enter"`, `"ArrowUp"`, `"F5"`, …).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Key {
    pub key: String,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
}

impl Key {
    pub fn new(key: &str) -> Self {
        Self { key: key.to_owned(), ..Self::default() }
    }

    /// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). 1 means none.
    fn modifier(&self) -> u8 {
        1 + self.shift as u8 + 2 * self.alt as u8 + 4 * self.ctrl as u8
    }
}

/// Bytes for a key press, or `None` if the terminal does not handle this key (let the UI have it).
pub fn encode_key(k: &Key, modes: &Modes) -> Option<Vec<u8>> {
    let m = k.modifier();
    let csi_mod = |final_byte: char| -> Vec<u8> {
        // Cursor keys and Home/End: `ESC [ 1 ; m X` with modifiers, else SS3 (app mode) or CSI.
        if m > 1 {
            format!("\x1b[1;{m}{final_byte}").into_bytes()
        } else if modes.app_cursor {
            format!("\x1bO{final_byte}").into_bytes()
        } else {
            format!("\x1b[{final_byte}").into_bytes()
        }
    };
    let tilde = |n: u8| -> Vec<u8> {
        if m > 1 { format!("\x1b[{n};{m}~").into_bytes() } else { format!("\x1b[{n}~").into_bytes() }
    };
    let function_ss3 = |final_byte: char| -> Vec<u8> {
        if m > 1 { format!("\x1b[1;{m}{final_byte}").into_bytes() } else { format!("\x1bO{final_byte}").into_bytes() }
    };
    let with_alt = |bytes: Vec<u8>| -> Vec<u8> {
        if k.alt {
            let mut v = vec![0x1b];
            v.extend(bytes);
            v
        } else {
            bytes
        }
    };

    let bytes = match k.key.as_str() {
        "ArrowUp" => csi_mod('A'),
        "ArrowDown" => csi_mod('B'),
        "ArrowRight" => csi_mod('C'),
        "ArrowLeft" => csi_mod('D'),
        "Home" => csi_mod('H'),
        "End" => csi_mod('F'),
        "Insert" => tilde(2),
        "Delete" => tilde(3),
        "PageUp" => tilde(5),
        "PageDown" => tilde(6),
        "F1" => function_ss3('P'),
        "F2" => function_ss3('Q'),
        "F3" => function_ss3('R'),
        "F4" => function_ss3('S'),
        "F5" => tilde(15),
        "F6" => tilde(17),
        "F7" => tilde(18),
        "F8" => tilde(19),
        "F9" => tilde(20),
        "F10" => tilde(21),
        "F11" => tilde(23),
        "F12" => tilde(24),
        "Enter" => with_alt(if modes.newline_mode() { b"\r\n".to_vec() } else { b"\r".to_vec() }),
        "Tab" if k.shift => b"\x1b[Z".to_vec(),
        "Tab" => with_alt(b"\t".to_vec()),
        // Ctrl+Backspace sends BS so readline deletes a word, as in xterm with `backarrowKey`.
        "Backspace" => with_alt(if k.ctrl { vec![0x08] } else { vec![0x7f] }),
        "Escape" => with_alt(vec![0x1b]),
        key => {
            let mut chars = key.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { return None };
            if k.ctrl {
                with_alt(vec![ctrl_byte(c)?])
            } else {
                let mut buf = [0u8; 4];
                with_alt(c.encode_utf8(&mut buf).as_bytes().to_vec())
            }
        }
    };
    Some(bytes)
}

/// The C0 byte for Ctrl+`c`, as xterm sends it.
fn ctrl_byte(c: char) -> Option<u8> {
    match c {
        'a'..='z' => Some(c as u8 - b'a' + 1),
        'A'..='Z' => Some(c as u8 - b'A' + 1),
        '@' | ' ' | '2' => Some(0x00),
        '[' | '3' => Some(0x1b),
        '\\' | '4' => Some(0x1c),
        ']' | '5' => Some(0x1d),
        '^' | '6' => Some(0x1e),
        '_' | '-' | '7' => Some(0x1f),
        '/' => Some(0x1f),
        '8' | '?' => Some(0x7f),
        _ => None,
    }
}

/// Bytes for pasted text: line breaks become CR (what Enter sends), and with bracketed paste the
/// text is wrapped so the shell can tell it from typing. An embedded end marker is removed so pasted
/// text cannot break out of the bracket.
pub fn encode_paste(text: &str, modes: &Modes) -> Vec<u8> {
    let normalized = text.replace("\r\n", "\r").replace('\n', "\r");
    if modes.bracketed_paste {
        let safe = normalized.replace("\x1b[201~", "");
        let mut out = b"\x1b[200~".to_vec();
        out.extend_from_slice(safe.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        out
    } else {
        normalized.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Terminal;

    fn modes(setup: &str) -> Modes {
        let mut t = Terminal::new(10, 2);
        t.advance(setup.as_bytes());
        t.modes()
    }

    fn key(name: &str, ctrl: bool, alt: bool, shift: bool) -> Key {
        Key { key: name.into(), ctrl, alt, shift }
    }

    fn enc(k: Key, m: &Modes) -> String {
        String::from_utf8(encode_key(&k, m).unwrap()).unwrap()
    }

    #[test]
    fn text_and_control_keys() {
        let m = modes("");
        assert_eq!(enc(Key::new("a"), &m), "a");
        assert_eq!(enc(Key::new("日"), &m), "日");
        assert_eq!(enc(Key::new("Enter"), &m), "\r");
        assert_eq!(enc(Key::new("Backspace"), &m), "\x7f");
        assert_eq!(enc(key("c", true, false, false), &m), "\x03");
        assert_eq!(enc(key("C", true, false, true), &m), "\x03");
        assert_eq!(enc(key("b", false, true, false), &m), "\x1bb");
        assert_eq!(enc(key("Tab", false, false, true), &m), "\x1b[Z");
        assert_eq!(encode_key(&Key::new("Shift"), &m), None);
        assert_eq!(encode_key(&key("1", true, false, false), &m), None);
    }

    #[test]
    fn cursor_keys_follow_application_mode() {
        assert_eq!(enc(Key::new("ArrowUp"), &modes("")), "\x1b[A");
        assert_eq!(enc(Key::new("ArrowUp"), &modes("\x1b[?1h")), "\x1bOA");
        assert_eq!(enc(key("ArrowRight", true, false, false), &modes("\x1b[?1h")), "\x1b[1;5C");
        assert_eq!(enc(key("ArrowLeft", false, true, true), &modes("")), "\x1b[1;4D");
    }

    #[test]
    fn function_and_editing_keys() {
        let m = modes("");
        assert_eq!(enc(Key::new("F1"), &m), "\x1bOP");
        assert_eq!(enc(key("F1", true, false, false), &m), "\x1b[1;5P");
        assert_eq!(enc(Key::new("F5"), &m), "\x1b[15~");
        assert_eq!(enc(key("Delete", false, false, true), &m), "\x1b[3;2~");
        assert_eq!(enc(Key::new("PageDown"), &m), "\x1b[6~");
    }

    #[test]
    fn newline_mode_sends_crlf_for_enter() {
        assert_eq!(enc(Key::new("Enter"), &modes("\x1b[20h")), "\r\n");
    }

    #[test]
    fn paste_normalizes_newlines_and_brackets() {
        assert_eq!(encode_paste("a\nb\r\nc", &modes("")), b"a\rb\rc");
        assert_eq!(encode_paste("x\n", &modes("\x1b[?2004h")), b"\x1b[200~x\r\x1b[201~");
        assert_eq!(encode_paste("evil\x1b[201~rm -rf /\n", &modes("\x1b[?2004h")), b"\x1b[200~evilrm -rf /\r\x1b[201~");
    }
}
