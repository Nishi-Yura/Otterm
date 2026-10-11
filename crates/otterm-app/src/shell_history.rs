//! The shells' own history files (docs/03 §8.5): PowerShell (PSReadLine), bash, zsh and fish.
//! The history UI merges their newest commands with otterm's own run records. Only the last 2 MiB
//! of each file is read, and secret-looking words are redacted like the run records (K1).

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// How much of each history file is read, counted from its end.
const TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// zsh writes its metafied bytes as this marker followed by the real byte XOR 0x20.
const META: u8 = 0x83;

/// One command from a shell's history file.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellEntry {
    /// The command with secrets redacted and the outer whitespace trimmed. Multi-line commands keep
    /// their newlines.
    pub command: String,
    /// `powershell`, `bash`, `zsh` or `fish`.
    pub shell: &'static str,
    /// ms since the Unix epoch, when the file records the time (zsh extended format, fish, and bash
    /// after `#<epoch>` timestamp lines). None otherwise.
    pub at: Option<i64>,
}

/// How a history file is laid out.
#[derive(Clone, Copy)]
enum Format {
    PowerShell,
    Bash,
    Zsh,
    Fish,
    /// `$HISTFILE` names whichever shell exported it, so the layout is detected from the content.
    Sniff,
}

/// A command with the time used to order it. `key` is ms since the epoch, or an estimate for
/// lines without a recorded time.
struct Raw {
    key: i64,
    file: usize,
    line: usize,
    shell: &'static str,
    command: String,
    at: Option<i64>,
}

/// The newest `limit` commands across the shells' history files, newest first, deduplicated by
/// command (keeping the newest), with secrets redacted (`crate::history::redact_secrets`).
///
/// Files that cannot be read are skipped. Lines without a recorded time are placed by the file's
/// modified time (its last line) and keep their file order.
pub fn read(limit: usize) -> Vec<ShellEntry> {
    if limit == 0 {
        return Vec::new();
    }
    let mut raws = Vec::new();
    for (file, (path, format)) in sources().into_iter().enumerate() {
        load(file, &path, format, &mut raws);
    }
    raws.sort_by(|a, b| b.key.cmp(&a.key).then(b.file.cmp(&a.file)).then(b.line.cmp(&a.line)));

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in raws {
        let command = crate::history::redact_secrets(raw.command.trim());
        if command.is_empty() || !seen.insert(command.clone()) {
            continue;
        }
        out.push(ShellEntry { command, shell: raw.shell, at: raw.at });
        if out.len() == limit {
            break;
        }
    }
    out
}

/// The history files to read. A path that appears twice is read once, with the first format.
fn sources() -> Vec<(PathBuf, Format)> {
    let home = std::env::home_dir();
    let env_path = |key: &str| std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    let mut out: Vec<(PathBuf, Format)> = Vec::new();
    let mut push = |path: Option<PathBuf>, format: Format| {
        if let Some(path) = path
            && !out.iter().any(|(p, _)| *p == path)
        {
            out.push((path, format));
        }
    };

    let powershell = if cfg!(windows) {
        env_path("APPDATA")
            .or_else(|| home.as_ref().map(|h| h.join("AppData").join("Roaming")))
            .map(|a| a.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"))
    } else {
        home.as_ref().map(|h| h.join(".local/share/powershell/PSReadLine/ConsoleHost_history.txt"))
    };
    push(powershell, Format::PowerShell);

    push(env_path("HISTFILE"), Format::Sniff);
    // On Windows this is also Git Bash's file, since its home is USERPROFILE.
    push(home.as_ref().map(|h| h.join(".bash_history")), Format::Bash);
    let zsh_dir = env_path("ZDOTDIR").or_else(|| home.clone());
    push(zsh_dir.map(|d| d.join(".zsh_history")), Format::Zsh);
    let fish_data = env_path("XDG_DATA_HOME").or_else(|| home.as_ref().map(|h| h.join(".local/share")));
    push(fish_data.map(|d| d.join("fish/fish_history")), Format::Fish);
    out
}

/// Reads one file and appends its commands to `out`. Unreadable files add nothing.
fn load(file: usize, path: &Path, format: Format, out: &mut Vec<Raw>) {
    let Some((bytes, mtime)) = read_tail(path) else {
        return;
    };
    let lossy = String::from_utf8_lossy(&bytes);
    let text = lossy.strip_prefix('\u{feff}').unwrap_or(&lossy);
    let (shell, items) = match format {
        Format::PowerShell => ("powershell", join_entries(text, no_head, psreadline_continues)),
        Format::Bash => ("bash", parse_bash(text)),
        Format::Fish => ("fish", parse_fish(text)),
        Format::Zsh => ("zsh", parse_zsh(&bytes)),
        Format::Sniff => {
            if text.lines().any(|line| zsh_head(line).1.is_some()) {
                ("zsh", parse_zsh(&bytes))
            } else {
                ("bash", parse_bash(text))
            }
        }
    };

    // Walking from the newest line: a timed line keeps its time, and an untimed line takes the time
    // of the line after it (the file's modified time for the last line), one ms earlier per line.
    let mut cur = mtime;
    for (line, (command, at)) in items.into_iter().enumerate().rev() {
        let key = match at {
            Some(t) => {
                cur = t.saturating_sub(1);
                t
            }
            None => {
                let k = cur;
                cur = cur.saturating_sub(1);
                k
            }
        };
        out.push(Raw { key, file, line, shell, command, at });
    }
}

/// The last `TAIL_BYTES` of the file (whole lines only), and its modified time in ms.
fn read_tail(path: &Path) -> Option<(Vec<u8>, i64)> {
    let mut file = File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta.modified().map_or(0, millis);
    let len = meta.len();
    let cut = len > TAIL_BYTES;
    if cut {
        file.seek(SeekFrom::Start(len - TAIL_BYTES)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    if cut {
        // The first line was probably cut in half.
        let skip = bytes.iter().position(|&b| b == b'\n').map_or(bytes.len(), |p| p + 1);
        bytes.drain(..skip);
    }
    Some((bytes, mtime))
}

fn millis(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// Groups physical lines into commands. `head` reads the start of a command's first line (its text
/// and time). `cont` returns the text of a line that continues onto the next one, or None.
fn join_entries(
    text: &str,
    head: fn(&str) -> (&str, Option<i64>),
    cont: fn(&str) -> Option<&str>,
) -> Vec<(String, Option<i64>)> {
    let mut out: Vec<(String, Option<i64>)> = Vec::new();
    let mut open = false;
    for line in text.lines() {
        let (raw, at) = if open { (line, None) } else { head(line) };
        let (body, more) = match cont(raw) {
            Some(body) => (body, true),
            None => (raw, false),
        };
        match out.last_mut() {
            Some(last) if open => {
                last.0.push('\n');
                last.0.push_str(body);
            }
            _ => out.push((body.to_owned(), at)),
        }
        open = more;
    }
    out
}

fn no_head(line: &str) -> (&str, Option<i64>) {
    (line, None)
}

/// A line ending in an odd number of backticks continues on the next line.
fn psreadline_continues(line: &str) -> Option<&str> {
    let ticks = line.bytes().rev().take_while(|&b| b == b'`').count();
    (ticks % 2 == 1).then(|| &line[..line.len() - 1])
}

/// Bash: a `#<epoch>` line is the time of the command after it.
fn parse_bash(text: &str) -> Vec<(String, Option<i64>)> {
    let mut out = Vec::new();
    let mut when = None;
    for line in text.lines() {
        if let Some(t) = bash_timestamp(line) {
            when = Some(t);
        } else {
            out.push((line.to_owned(), when.take()));
        }
    }
    out
}

fn bash_timestamp(line: &str) -> Option<i64> {
    let digits = line.strip_prefix('#').filter(|d| is_digits(d))?;
    digits.parse::<i64>().ok().map(|secs| secs.saturating_mul(1000))
}

/// zsh extended format `: <epoch>:<duration>;<command>`. The line is a plain command otherwise.
fn zsh_head(line: &str) -> (&str, Option<i64>) {
    let parsed = line.strip_prefix(": ").and_then(|rest| {
        let (epoch, rest) = rest.split_once(':')?;
        let (duration, command) = rest.split_once(';')?;
        (is_digits(epoch) && is_digits(duration)).then_some((command, epoch))
    });
    match parsed {
        Some((command, epoch)) => (command, epoch.parse::<i64>().ok().map(|secs| secs.saturating_mul(1000))),
        None => (line, None),
    }
}

/// zsh writes a newline inside a command as a backslash at the end of the line.
fn zsh_continues(line: &str) -> Option<&str> {
    line.strip_suffix('\\')
}

fn parse_zsh(bytes: &[u8]) -> Vec<(String, Option<i64>)> {
    let text = String::from_utf8_lossy(&unmetafy(bytes)).into_owned();
    join_entries(&text, zsh_head, zsh_continues)
}

/// Undoes zsh's metafication: `META` followed by `b` stands for `b ^ 0x20`.
fn unmetafy(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut iter = bytes.iter().copied();
    while let Some(b) = iter.next() {
        if b == META {
            if let Some(next) = iter.next() {
                out.push(next ^ 0x20);
            }
        } else {
            out.push(b);
        }
    }
    out
}

/// fish: `- cmd: <command>` with `  when: <epoch>` on the next line. The command escapes `\\` and `\n`.
fn parse_fish(text: &str) -> Vec<(String, Option<i64>)> {
    let mut out: Vec<(String, Option<i64>)> = Vec::new();
    for line in text.lines() {
        if let Some(cmd) = line.strip_prefix("- cmd:") {
            out.push((fish_unescape(cmd.strip_prefix(' ').unwrap_or(cmd)), None));
        } else if let Some(when) = line.strip_prefix("  when:")
            && let Some(last) = out.last_mut()
            && let Ok(secs) = when.trim().parse::<i64>()
        {
            last.1 = Some(secs.saturating_mul(1000));
        }
    }
    out
}

fn fish_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}
