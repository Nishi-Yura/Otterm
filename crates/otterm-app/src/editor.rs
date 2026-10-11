//! Launching the user's editor on a file (docs/03 §9.4, decision I16).
//!
//! Every program starts from an argument list, never a shell string, so a path taken from
//! terminal output cannot inject commands.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde::Serialize;

/// An editor otterm can open files in (docs/03 §9.4, decision I16).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editor {
    pub id: String,
    pub name: String,
    pub program: PathBuf,
}

/// A built-in editor. `id` is the value of `open.editor`.
struct Preset {
    id: &'static str,
    name: &'static str,
    program: &'static str,
}

/// Detection order. nvim and vim are detected so the settings screen can list them, but `open`
/// never picks them on its own: they need a terminal, which a detached launch does not have.
const PRESETS: &[Preset] = &[
    Preset { id: "code", name: "VS Code", program: "code" },
    Preset { id: "cursor", name: "Cursor", program: "cursor" },
    Preset { id: "zed", name: "Zed", program: "zed" },
    Preset { id: "subl", name: "Sublime Text", program: "subl" },
    Preset { id: "nvim", name: "Neovim", program: "nvim" },
    Preset { id: "vim", name: "Vim", program: "vim" },
];

/// Editors found on this computer, in preference order: PATH first, then known install folders.
/// Each preset appears at most once. Cached in a OnceLock, so the disk is checked once per run.
pub fn detect() -> &'static [Editor] {
    static FOUND: OnceLock<Vec<Editor>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            let mut found: Vec<Editor> = Vec::new();
            for preset in PRESETS {
                if let Some(program) = on_path(&candidates(OsStr::new(preset.program))) {
                    found.push(editor(preset, program));
                }
            }
            // A PATH hit wins over an install folder, so every PATH preset comes before any
            // install-folder-only preset.
            let installs = known_installs();
            for preset in PRESETS {
                if found.iter().any(|e| e.id == preset.id) {
                    continue;
                }
                let hit = installs.iter().find(|(id, path)| *id == preset.id && path.is_file());
                if let Some((_, program)) = hit {
                    found.push(editor(preset, program.clone()));
                }
            }
            found
        })
        .as_slice()
}

/// Open `path` (at `line`:`col` when given) with the configured editor: `open.editor` preset id, or
/// "custom" with `open.editor_template`, or "" = the first detected editor, else the platform's text
/// editor (notepad.exe / `open -t` / xdg-open).
///
/// The automatic choice skips terminal editors. A preset id that is not detected falls back to the
/// automatic choice. The platform editor takes no line position, so the line is dropped there.
pub fn open(path: &Path, line: Option<u32>, col: Option<u32>, open: &otterm_config::Open) -> io::Result<()> {
    // UI tests record the request instead of launching an editor (see open_url in main.rs).
    if let Some(log) = std::env::var_os("OTTERM_TEST_OPEN_LOG") {
        use std::io::Write;
        let shown = match line {
            Some(l) => format!("{}:{l}:{}", path.display(), col.unwrap_or(1)),
            None => path.display().to_string(),
        };
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
        return writeln!(f, "editor {shown}");
    }
    let id = open.editor.trim().to_ascii_lowercase();
    if id == "custom" {
        return launch_template(open.editor_template.as_deref(), path, line, col);
    }
    let found = detect();
    if !id.is_empty()
        && let Some(editor) = found.iter().find(|e| e.id == id)
    {
        return launch_preset(editor, path, line, col);
    }
    match found.iter().find(|e| !is_terminal(&e.id)) {
        Some(editor) => launch_preset(editor, path, line, col),
        None => launch_platform(path),
    }
}

fn editor(preset: &Preset, program: PathBuf) -> Editor {
    Editor { id: preset.id.into(), name: preset.name.into(), program }
}

/// Install locations as (preset id, program), in preference order.
fn known_installs() -> Vec<(&'static str, PathBuf)> {
    let mut v: Vec<(&'static str, PathBuf)> = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            v.push(("code", local.join(r"Programs\Microsoft VS Code\bin\code.cmd")));
            v.push(("cursor", local.join(r"Programs\cursor\resources\app\bin\cursor.cmd")));
            v.push(("zed", local.join(r"Programs\Zed\zed.exe")));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            v.push(("code", pf.join(r"Microsoft VS Code\bin\code.cmd")));
            v.push(("subl", pf.join(r"Sublime Text\subl.exe")));
        }
    } else if cfg!(target_os = "macos") {
        v.push(("code", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code".into()));
        v.push(("cursor", "/Applications/Cursor.app/Contents/Resources/app/bin/cursor".into()));
        v.push(("zed", "/Applications/Zed.app/Contents/MacOS/cli".into()));
        v.push(("subl", "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl".into()));
    } else {
        v.push(("code", "/usr/bin/code".into()));
        v.push(("code", "/usr/share/code/bin/code".into()));
        if let Some(home) = std::env::var_os("HOME") {
            v.push(("zed", PathBuf::from(home).join(".local/bin/zed")));
        }
        v.push(("code", "/snap/bin/code".into()));
    }
    v
}

fn is_terminal(id: &str) -> bool {
    matches!(id, "nvim" | "vim")
}

/// Start a built-in editor with its own syntax for a position.
fn launch_preset(editor: &Editor, path: &Path, line: Option<u32>, col: Option<u32>) -> io::Result<()> {
    let at = line.map(|l| with_position(path, l, col));
    let mut cmd = Command::new(&editor.program);
    match editor.id.as_str() {
        // VS Code and Cursor take `-g` in front of a line position.
        "code" | "cursor" => {
            match at {
                Some(at) => cmd.arg("-g").arg(at),
                None => cmd.arg(path),
            };
        }
        "zed" | "subl" => {
            cmd.arg(at.unwrap_or_else(|| path.as_os_str().to_owned()));
        }
        // Refused rather than launched: a detached terminal editor has no terminal, so it exits
        // at once or sits there with no way to be used.
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!(
                    "{} runs in a terminal, so otterm cannot open files with it. Set open.editor to a GUI editor (code, cursor, zed, subl).",
                    editor.name
                ),
            ));
        }
    }
    spawn(cmd)
}

/// `open.editor = "custom"`: the template is split into words first and the placeholders are
/// replaced inside each word, so a path with spaces stays one argument.
fn launch_template(template: Option<&str>, path: &Path, line: Option<u32>, col: Option<u32>) -> io::Result<()> {
    let template = template
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| invalid("open.editor is \"custom\" but open.editor_template is empty"))?;
    let words = split_words(template).map_err(|e| invalid(format!("open.editor_template: {e}")))?;
    let (line, col) = (line.unwrap_or(1), col.unwrap_or(1));
    let mut expanded = words.iter().map(|w| expand(w, path.as_os_str(), line, col));
    let program = expanded.next().ok_or_else(|| invalid("open.editor_template is empty"))?;
    let mut cmd = Command::new(resolve_program(program));
    cmd.args(expanded);
    spawn(cmd)
}

/// The platform's text editor. It has no line option, so a position is not passed.
fn launch_platform(path: &Path) -> io::Result<()> {
    let cmd = if cfg!(windows) {
        let mut c = Command::new("notepad.exe");
        c.arg(path);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg("-t").arg(path);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(path);
        c
    };
    spawn(cmd)
}

/// Start the editor and do not wait for it.
fn spawn(mut cmd: Command) -> io::Result<()> {
    // No stdio: the editor is detached, so it must not keep otterm's pipes or console open.
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd.spawn().map(drop)
}

/// Batch files run under cmd.exe, which would flash a console window unless told not to.
#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let batch = Path::new(cmd.get_program())
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if batch {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

fn invalid(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, msg.into())
}

/// `path:line:col`, with the column defaulting to 1 as the position always has.
fn with_position(path: &Path, line: u32, col: Option<u32>) -> OsString {
    let mut s = path.as_os_str().to_owned();
    s.push(format!(":{line}:{}", col.unwrap_or(1)));
    s
}

/// Splits a template into words the way a shell does for quotes only: whitespace separates,
/// double quotes group (and are removed), and backslashes stay literal so Windows paths survive.
fn split_words(s: &str) -> Result<Vec<String>, &'static str> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                in_word = true;
            }
            c if c.is_whitespace() && !quoted => {
                if in_word {
                    words.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                cur.push(c);
                in_word = true;
            }
        }
    }
    if quoted {
        return Err("unclosed double quote");
    }
    if in_word {
        words.push(cur);
    }
    Ok(words)
}

/// Replaces `{path}`, `{line}` and `{col}` in one word. The path is pushed as an OsStr, so a
/// non-UTF-8 path arrives intact.
fn expand(word: &str, path: &OsStr, line: u32, col: u32) -> OsString {
    const PATH: &str = "{path}";
    const LINE: &str = "{line}";
    const COL: &str = "{col}";
    let mut out = OsString::new();
    let mut rest = word;
    while let Some(start) = rest.find('{') {
        out.push(&rest[..start]);
        rest = &rest[start..];
        let (value, len) = if rest.starts_with(PATH) {
            (path.to_owned(), PATH.len())
        } else if rest.starts_with(LINE) {
            (OsString::from(line.to_string()), LINE.len())
        } else if rest.starts_with(COL) {
            (OsString::from(col.to_string()), COL.len())
        } else {
            (OsString::from("{"), 1)
        };
        out.push(value);
        rest = &rest[len..];
    }
    out.push(rest);
    out
}

/// File names to try for a program. On Windows a bare name is tried as `.exe` then `.cmd`, never
/// as itself: VS Code's bin folder also holds an extensionless shell script that CreateProcess
/// cannot run. A name that already has an extension is tried as given first.
fn candidates(name: &OsStr) -> Vec<OsString> {
    if !cfg!(windows) {
        return vec![name.to_owned()];
    }
    let mut names = Vec::new();
    if Path::new(name).extension().is_some() {
        names.push(name.to_owned());
    }
    for ext in [".exe", ".cmd"] {
        let mut n = name.to_owned();
        n.push(ext);
        names.push(n);
    }
    names
}

/// The first existing file on PATH with one of `names`. Directories are searched in PATH order.
fn on_path(names: &[OsString]) -> Option<PathBuf> {
    let dirs = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&dirs) {
        for name in names {
            let file = dir.join(name);
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

/// A bare program name is looked up on PATH. Anything with a directory part is used as written.
/// A name not found is kept, so the spawn fails with the usual "not found" error.
fn resolve_program(program: OsString) -> PathBuf {
    let p = PathBuf::from(&program);
    let bare = p.parent().is_some_and(|d| d.as_os_str().is_empty());
    if !bare {
        return p;
    }
    on_path(&candidates(&program)).unwrap_or(p)
}
