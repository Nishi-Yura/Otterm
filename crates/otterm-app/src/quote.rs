//! Quoting dropped file paths for the shell that receives them (FR-FILE-03).

use std::path::Path;

/// How a shell wants a path quoted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    /// PowerShell: '...' with ' doubled.
    PowerShell,
    /// cmd.exe: "..." (a Windows path cannot contain ").
    Cmd,
    /// sh, bash, zsh, fish and anything else: '...' with ' written as '\''.
    Posix,
}

impl Style {
    /// The style for a shell, from its program name or path.
    pub fn for_shell(program: &str) -> Style {
        let name = Path::new(program).file_stem().and_then(|s| s.to_str()).unwrap_or(program).to_ascii_lowercase();
        match name.as_str() {
            "pwsh" | "powershell" => Style::PowerShell,
            "cmd" => Style::Cmd,
            _ => Style::Posix,
        }
    }
}

/// Characters that never need quoting in any of the styles.
fn plain(path: &str) -> bool {
    !path.is_empty() && path.chars().all(|c| c.is_alphanumeric() || "_-.,/\\:+@".contains(c))
}

/// One path, quoted only when it needs it.
pub fn quote(path: &str, style: Style) -> String {
    if plain(path) {
        return path.to_string();
    }
    match style {
        Style::PowerShell => format!("'{}'", path.replace('\'', "''")),
        Style::Cmd => format!("\"{path}\""),
        Style::Posix => format!("'{}'", path.replace('\'', "'\\''")),
    }
}

/// Dropped paths as one line for the shell: quoted, separated by spaces, with a trailing space so
/// that the next word or drop does not run into them.
pub fn dropped(paths: &[String], style: Style) -> String {
    let mut out: Vec<String> = paths.iter().filter(|p| !p.is_empty()).map(|p| quote(p, style)).collect();
    if out.is_empty() {
        return String::new();
    }
    out.push(String::new());
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn style_comes_from_the_program_name() {
        assert_eq!(Style::for_shell("pwsh.exe"), Style::PowerShell);
        assert_eq!(Style::for_shell(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"), Style::PowerShell);
        assert_eq!(Style::for_shell("CMD.EXE"), Style::Cmd);
        assert_eq!(Style::for_shell("/bin/zsh"), Style::Posix);
        assert_eq!(Style::for_shell(r"C:\Program Files\Git\bin\bash.exe"), Style::Posix);
    }

    #[test]
    fn simple_paths_stay_as_they_are() {
        for style in [Style::PowerShell, Style::Cmd, Style::Posix] {
            assert_eq!(quote(r"C:\work\notes.txt", style), r"C:\work\notes.txt");
            assert_eq!(quote("/home/me/a-b_c.tar.gz", style), "/home/me/a-b_c.tar.gz");
        }
        // Non-ASCII letters are fine unquoted.
        assert_eq!(quote(r"C:\資料\メモ.txt", Style::PowerShell), r"C:\資料\メモ.txt");
    }

    #[test]
    fn spaces_and_quotes_are_quoted_per_shell() {
        let p = r"C:\My Files\it's.txt";
        assert_eq!(quote(p, Style::PowerShell), r"'C:\My Files\it''s.txt'");
        assert_eq!(quote(p, Style::Cmd), r#""C:\My Files\it's.txt""#);
        assert_eq!(quote("/tmp/it's here", Style::Posix), r"'/tmp/it'\''s here'");
        // Characters a shell would expand or split on.
        assert_eq!(quote("/tmp/$HOME&(x)", Style::Posix), "'/tmp/$HOME&(x)'");
        assert_eq!(quote(r"C:\a&b", Style::Cmd), r#""C:\a&b""#);
        assert_eq!(quote(r"C:\$env:x", Style::PowerShell), r"'C:\$env:x'");
    }

    #[test]
    fn several_paths_make_one_line() {
        let paths = vec![r"C:\a.txt".to_string(), r"C:\b c.txt".to_string()];
        assert_eq!(dropped(&paths, Style::PowerShell), r"C:\a.txt 'C:\b c.txt' ");
        assert_eq!(dropped(&[], Style::Posix), "");
    }
}
