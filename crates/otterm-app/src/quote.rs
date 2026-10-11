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
    /// A shell inside WSL: like Posix, with C:\x written as /mnt/c/x (docs/03, decision J2).
    Wsl,
}

impl Style {
    /// The style for a shell, from its program name or path.
    pub fn for_shell(program: &str) -> Style {
        let name = Path::new(program).file_stem().and_then(|s| s.to_str()).unwrap_or(program).to_ascii_lowercase();
        match name.as_str() {
            "pwsh" | "powershell" => Style::PowerShell,
            "cmd" => Style::Cmd,
            "wsl" => Style::Wsl,
            _ => Style::Posix,
        }
    }
}

/// Characters that need no quoting in the style. A backslash is an escape in sh-like shells, and
/// a comma builds an array in PowerShell.
fn plain(path: &str, style: Style) -> bool {
    let extra = match style {
        Style::Posix | Style::Wsl => "/:+@",
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
        Style::Posix | Style::Wsl => format!("'{}'", path.replace('\'', "'\\''")),
    })
}

/// A Windows path as WSL sees it: C:\Users\me → /mnt/c/Users/me. Other paths stay as they are.
fn wsl_path(path: &str) -> String {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    // A file inside a distribution, seen from Windows: \\wsl.localhost\Ubuntu\home → /home.
    for share in [r"\\wsl.localhost\", r"\\wsl$\"] {
        if let Some(rest) =
            path.get(..share.len()).filter(|p| p.eq_ignore_ascii_case(share)).map(|_| &path[share.len()..])
        {
            let inside = rest.split_once('\\').map_or("", |(_, inside)| inside);
            return format!("/{}", inside.replace('\\', "/"));
        }
    }
    let b = path.as_bytes();
    let drive_root = b.len() == 2 || (b.len() >= 3 && (b[2] == b'\\' || b[2] == b'/'));
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && drive_root {
        let drive = (b[0] as char).to_ascii_lowercase();
        return format!("/mnt/{drive}/{}", path.get(3..).unwrap_or("").replace('\\', "/"));
    }
    path.to_string()
}

/// Dropped paths as one line for the shell: quoted, separated by spaces, with a trailing space so
/// that the next word or drop does not run into them. Paths that cannot be typed safely are
/// returned separately.
pub fn dropped(paths: &[String], style: Style) -> (String, Vec<String>) {
    let mut out = Vec::new();
    let mut refused = Vec::new();
    for p in paths.iter().filter(|p| !p.is_empty()) {
        let converted = if style == Style::Wsl { wsl_path(p) } else { p.clone() };
        match quote(&converted, style) {
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
