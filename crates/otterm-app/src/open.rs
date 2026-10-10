//! Paths in terminal output (FR-FILE-06): finding the file a word names and opening it.

use std::path::{Path, PathBuf};

/// A file or folder named in the output, with the line and column after it, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub path: PathBuf,
    pub line: Option<u32>,
    pub col: Option<u32>,
}

/// `path`, `path:line` or `path:line:col` (a trailing `:` as in compiler output is fine).
fn split_position(text: &str) -> (&str, Option<u32>, Option<u32>) {
    let text = text.strip_suffix(':').unwrap_or(text);
    let number = |s: &str| (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten();
    if let Some((rest, last)) = text.rsplit_once(':')
        && let Some(n) = number(last)
        && !rest.is_empty()
    {
        if let Some((path, line)) = rest.rsplit_once(':')
            && let Some(l) = number(line)
            && !path.is_empty()
        {
            return (path, Some(l), Some(n));
        }
        return (rest, Some(n), None);
    }
    (text, None, None)
}

/// Extensions (with the dot, lower case) whose default action is to run something.
pub fn runs_when_opened(ext: &str) -> bool {
    const RUN: [&str; 22] = [
        ".exe",
        ".com",
        ".bat",
        ".cmd",
        ".ps1",
        ".psm1",
        ".vbs",
        ".vbe",
        ".js",
        ".jse",
        ".wsf",
        ".wsh",
        ".msi",
        ".msp",
        ".scr",
        ".lnk",
        ".url",
        ".hta",
        ".cpl",
        ".reg",
        ".jar",
        ".appref-ms",
    ];
    RUN.contains(&ext)
}

/// Only paths on this computer: a UNC path (\\server\share, \\?\, \\.\) would make Windows
/// connect to that server, sending the user's credentials, just to check whether the file
/// exists. A drive without a root (C:foo) depends on a per-drive folder otterm does not know.
pub fn local(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    let s = path.to_string_lossy();
    if s.starts_with("\\\\") || s.starts_with("//") {
        return false;
    }
    let mut parts = path.components();
    match parts.next() {
        Some(Component::Prefix(p)) => {
            matches!(p.kind(), Prefix::Disk(_)) && matches!(parts.next(), Some(Component::RootDir))
        }
        _ => true,
    }
}

/// The existing file or folder that `text` names, relative paths resolved against `cwd`.
pub fn resolve(cwd: Option<&Path>, text: &str, home: Option<&Path>) -> Option<Target> {
    if text.len() > 1024 || text.contains('\0') {
        return None;
    }
    let cwd = cwd.filter(|c| local(c));
    let (name, line, col) = split_position(text);
    let path = match (name.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(name),
    };
    if !local(&path) {
        return None;
    }
    let path = if path.is_absolute() { path } else { cwd?.join(path) };
    // Leave out names that only exist as a drive-relative or otherwise odd path.
    let path = std::path::absolute(&path).ok()?;
    path.exists().then_some(Target { path, line, col })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_and_column_come_off_the_end() {
        assert_eq!(split_position("src/app.ts:42"), ("src/app.ts", Some(42), None));
        assert_eq!(split_position("src/app.ts:42:7:"), ("src/app.ts", Some(42), Some(7)));
        assert_eq!(split_position(r"C:\x\main.rs:3"), (r"C:\x\main.rs", Some(3), None));
        assert_eq!(split_position(r"C:\x\main.rs"), (r"C:\x\main.rs", None, None));
        assert_eq!(split_position("notes.txt:"), ("notes.txt", None, None));
        assert_eq!(split_position(":12"), (":12", None, None));
    }

    #[test]
    fn network_and_drive_relative_paths_are_never_looked_up() {
        assert!(!local(Path::new(r"\\attacker\share\a.txt")));
        assert!(!local(Path::new("//attacker/share/a.txt")));
        assert!(!local(Path::new(r"\\?\C:\Windows")));
        assert!(local(Path::new("src/a.rs")));
        if cfg!(windows) {
            assert!(!local(Path::new("C:foo")));
            assert!(local(Path::new(r"C:\Windows")));
            assert!(resolve(Some(Path::new(r"\\attacker\share")), "a.txt", None).is_none());
            assert!(resolve(None, r"\\localhost\c$\Windows", None).is_none());
            assert!(resolve(Some(Path::new(r"C:\")), "C:Windows", None).is_none());
        }
    }

    #[test]
    fn programs_are_recognised() {
        assert!(runs_when_opened(".exe") && runs_when_opened(".lnk") && runs_when_opened(".ps1"));
        assert!(!runs_when_opened(".pdf") && !runs_when_opened(".md"));
    }

    #[test]
    fn relative_paths_resolve_against_the_folder_and_must_exist() {
        let dir = std::env::temp_dir().join(format!("otterm-open-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join("app.ts"), "x").unwrap();
        let t = resolve(Some(&dir), "src/app.ts:42:7", None).unwrap();
        assert_eq!(t.path, dir.join("src").join("app.ts"));
        assert_eq!((t.line, t.col), (Some(42), Some(7)));
        assert!(resolve(Some(&dir), "src", None).is_some(), "folders count");
        assert!(resolve(Some(&dir), "src/missing.ts", None).is_none());
        assert!(resolve(None, "src/app.ts", None).is_none(), "no folder, no relative paths");
        // ~ is the home folder.
        let t = resolve(None, "~/src/app.ts:1", Some(&dir)).unwrap();
        assert_eq!(t.path, dir.join("src").join("app.ts"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
