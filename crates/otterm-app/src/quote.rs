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

/// Characters that need no quoting in the style. A backslash is an escape in sh-like shells, and
/// a comma builds an array in PowerShell.
fn plain(path: &str, style: Style) -> bool {
    let extra = match style {
        Style::Posix => "/:+@",
        Style::PowerShell | Style::Cmd => "/\\:+@",
    };
    !path.is_empty() && path.chars().all(|c| c.is_alphanumeric() || "_-.".contains(c) || extra.contains(c))
}

/// PowerShell takes these as single quotes too, so each is doubled like '.
const PS_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// One path, quoted only when it needs it. `None` for a path that cannot be typed safely: cmd
/// expands %VAR% and !VAR! even inside double quotes.
pub fn quote(path: &str, style: Style) -> Option<String> {
    if path.chars().any(char::is_control) {
        return None;
    }
    if plain(path, style) {
        return Some(path.to_string());
    }
    Some(match style {
        Style::PowerShell => {
            let mut out = String::from("'");
            for c in path.chars() {
                out.push(c);
                if PS_QUOTES.contains(&c) {
                    out.push(c);
                }
            }
            out.push('\'');
            out
        }
        Style::Cmd if path.contains(['%', '!']) => return None,
        Style::Cmd => format!("\"{path}\""),
        Style::Posix => format!("'{}'", path.replace('\'', "'\\''")),
    })
}

/// Dropped paths as one line for the shell: quoted, separated by spaces, with a trailing space so
/// that the next word or drop does not run into them. Paths that cannot be typed safely are
/// returned separately.
pub fn dropped(paths: &[String], style: Style) -> (String, Vec<String>) {
    let mut out = Vec::new();
    let mut refused = Vec::new();
    for p in paths.iter().filter(|p| !p.is_empty()) {
        match quote(p, style) {
            Some(q) => out.push(q),
            None => refused.push(p.clone()),
        }
    }
    if out.is_empty() {
        return (String::new(), refused);
    }
    out.push(String::new());
    (out.join(" "), refused)
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

    fn q(path: &str, style: Style) -> String {
        quote(path, style).unwrap()
    }

    #[test]
    fn simple_paths_stay_as_they_are() {
        for style in [Style::PowerShell, Style::Cmd, Style::Posix] {
            assert_eq!(q("/home/me/a-b_c.tar.gz", style), "/home/me/a-b_c.tar.gz");
        }
        assert_eq!(q(r"C:\work\notes.txt", Style::PowerShell), r"C:\work\notes.txt");
        assert_eq!(q(r"C:\work\notes.txt", Style::Cmd), r"C:\work\notes.txt");
        // Non-ASCII letters are fine unquoted.
        assert_eq!(q(r"C:\資料\メモ.txt", Style::PowerShell), r"C:\資料\メモ.txt");
    }

    #[test]
    fn spaces_and_quotes_are_quoted_per_shell() {
        let p = r"C:\My Files\it's.txt";
        assert_eq!(q(p, Style::PowerShell), r"'C:\My Files\it''s.txt'");
        assert_eq!(q(p, Style::Cmd), r#""C:\My Files\it's.txt""#);
        assert_eq!(q("/tmp/it's here", Style::Posix), r"'/tmp/it'\''s here'");
        // Characters a shell would expand or split on.
        assert_eq!(q("/tmp/$HOME&(x)", Style::Posix), "'/tmp/$HOME&(x)'");
        assert_eq!(q(r"C:\a&b", Style::Cmd), r#""C:\a&b""#);
        assert_eq!(q(r"C:\$env:x", Style::PowerShell), r"'C:\$env:x'");
    }

    #[test]
    fn backslashes_are_quoted_for_sh_and_commas_for_powershell() {
        assert_eq!(q(r"C:\Users\me\a.txt", Style::Posix), r"'C:\Users\me\a.txt'");
        assert_eq!(q(r"C:\a,b.txt", Style::PowerShell), r"'C:\a,b.txt'");
    }

    #[test]
    fn typographic_quotes_cannot_end_a_powershell_string() {
        let p = "C:\\a\u{2019}; Remove-Item x; \u{2018}b.txt";
        assert_eq!(q(p, Style::PowerShell), "'C:\\a\u{2019}\u{2019}; Remove-Item x; \u{2018}\u{2018}b.txt'");
    }

    #[test]
    fn cmd_refuses_percent_and_bang_and_nobody_takes_control_characters() {
        assert_eq!(quote(r"C:\a%USERNAME%.txt", Style::Cmd), None);
        assert_eq!(quote(r"C:\wow!.txt", Style::Cmd), None);
        assert_eq!(q(r"C:\a%b.txt", Style::PowerShell), r"'C:\a%b.txt'");
        assert_eq!(quote("/tmp/a\nrm -rf x", Style::Posix), None);
    }

    #[test]
    fn several_paths_make_one_line() {
        let paths = vec![r"C:\a.txt".to_string(), r"C:\b c.txt".to_string(), r"C:\100%.txt".to_string()];
        assert_eq!(dropped(&paths[..2], Style::PowerShell).0, r"C:\a.txt 'C:\b c.txt' ");
        assert_eq!(
            dropped(&paths, Style::Cmd),
            (r#"C:\a.txt "C:\b c.txt" "#.to_string(), vec![r"C:\100%.txt".to_string()])
        );
        assert_eq!(dropped(&[], Style::Posix).0, "");
    }
}
