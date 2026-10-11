//! Shell integration loaded through the shell's start arguments and environment (decision B6: no
//! user file is changed; docs/03 §6.2). The hooks send OSC 133 (prompt, command, exit code),
//! OSC 7 (the folder) and otterm's OSC 7777 (the command line and the prompt bar, decision M4).
//!
//! PowerShell gets its hook inline (`-EncodedCommand`). bash, zsh and fish read theirs from
//! `<config dir>/shell-integration/`, which [`integrate`] writes from the copies compiled in, so
//! the user can read the scripts ("show script" in docs/03 §6.2).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use otterm_config::PromptStyle;

const PWSH_SCRIPT: &str = include_str!("shell/otterm.ps1");

/// Scripts written to the integration folder: (relative path, content).
const HOOK_FILES: &[(&str, &str)] = &[
    ("otterm.ps1", PWSH_SCRIPT),
    ("otterm.bash", include_str!("shell/otterm.bash")),
    ("otterm.zsh", include_str!("shell/otterm.zsh")),
    ("otterm.fish", include_str!("shell/otterm.fish")),
    ("zsh/.zshenv", include_str!("shell/zsh/.zshenv")),
    ("zsh/.zprofile", include_str!("shell/zsh/.zprofile")),
    ("zsh/.zshrc", include_str!("shell/zsh/.zshrc")),
    ("zsh/.zlogin", include_str!("shell/zsh/.zlogin")),
];

/// How to start a shell so that it loads otterm's hooks.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Integration {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

fn stem_of(program: &str) -> String {
    Path::new(program).file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// `program` started without the user's startup files (decision M24), for when the integration is
/// off: its hooks skip those files themselves. Shells that take no such flag, and invocations that
/// run a command of their own, keep their arguments.
pub fn clean_start(program: &str, args: Vec<String>) -> Vec<String> {
    let lower: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    let has = |flags: &[&str]| lower.iter().any(|a| flags.contains(&a.as_str()));
    let mut args = args;
    match stem_of(program).as_str() {
        "pwsh" | "powershell" if !has(&["-noprofile", "-nop"]) => args.insert(0, "-NoProfile".to_owned()),
        "cmd" if !has(&["/d"]) => args.insert(0, "/D".to_owned()),
        "bash" if !has(&["-c", "--rcfile", "--init-file", "--norc"]) => {
            args.splice(0..0, ["--noprofile".to_owned(), "--norc".to_owned()]);
        }
        "zsh" if !has(&["-c", "-f", "--no-rcs"]) => args.insert(0, "-f".to_owned()),
        "fish" if !has(&["-c", "--command", "-n", "--no-config"]) => args.insert(0, "--no-config".to_owned()),
        _ => {}
    }
    args
}

/// `program` with `args` and the integration for it. Shells otterm has no hook for (nu, WSL's
/// launcher), and invocations that run a command or script of their own (`-c`, `-File`), keep their
/// arguments unchanged. Without `user_files`, the shell's own startup files are not read
/// (decision M24).
pub fn integrate(program: &str, args: Vec<String>, prompt: PromptStyle, user_files: bool) -> Integration {
    let stem = stem_of(program);
    let mode = match prompt {
        PromptStyle::Otterm => "otterm",
        PromptStyle::Shell => "shell",
    };
    let mut env = vec![("OTTERM_PROMPT".to_owned(), mode.to_owned())];
    if !user_files {
        // The bash and zsh hooks source the user's files themselves unless this says not to.
        env.push(("OTTERM_USER_STARTUP".to_owned(), "0".to_owned()));
    }
    let plain = Integration {
        args: if user_files { args.clone() } else { clean_start(program, args.clone()) },
        env: Vec::new(),
    };
    // Written for every shell, so the user can read the scripts whichever shell they run.
    let dir = hooks_dir();
    let lower: Vec<String> = args.iter().map(|a| a.to_ascii_lowercase()).collect();
    let has = |flags: &[&str]| lower.iter().any(|a| flags.contains(&a.as_str()));
    match stem.as_str() {
        "pwsh" | "powershell" => {
            if has(&["-c", "-command", "-f", "-file", "-e", "-ec", "-encodedcommand"]) {
                return plain;
            }
            // The script goes inline (-EncodedCommand: base64 of UTF-16LE). Dot-sourcing a file
            // would be refused under the default execution policy of Windows PowerShell 5.1
            // (Restricted), and otterm should not loosen the user's policy. -NoExit keeps the shell
            // open; the profile still loads first, so the script wraps the prompt it set up.
            let mut args = args;
            if !has(&["-nologo"]) {
                args.push("-NoLogo".to_owned());
            }
            if !user_files && !has(&["-noprofile", "-nop"]) {
                args.push("-NoProfile".to_owned());
            }
            args.extend(["-NoExit".to_owned(), "-EncodedCommand".to_owned(), encode_command(PWSH_SCRIPT)]);
            Integration { args, env }
        }
        "cmd" => plain,
        "bash" => {
            if has(&["-c", "--rcfile", "--init-file", "--norc", "--posix", "-s"]) {
                return plain;
            }
            let Some(dir) = dir else { return plain };
            // --rcfile replaces ~/.bashrc, so the hook sources the user's files itself. A login
            // shell (-l) reads the profile files instead; bash ignores --rcfile then, so the flag
            // goes and the hook emulates the login sequence (OTTERM_SHELL_LOGIN).
            let mut rest = Vec::new();
            let mut login = false;
            for a in args {
                match a.as_str() {
                    "-l" | "--login" => login = true,
                    // "-il", "-li" and the like.
                    s if s.len() > 1 && !s.starts_with("--") && s.starts_with('-') && s.contains('l') => {
                        login = true;
                        let short: String = s.chars().filter(|&c| c != 'l').collect();
                        if short != "-" {
                            rest.push(short);
                        }
                    }
                    _ => rest.push(a),
                }
            }
            if login {
                env.push(("OTTERM_SHELL_LOGIN".to_owned(), "1".to_owned()));
            }
            // bash takes its GNU long options before the short ones ("-i --rcfile x" is an error).
            let mut args = vec!["--rcfile".to_owned(), shell_path(&dir.join("otterm.bash"))];
            args.extend(rest);
            Integration { args, env }
        }
        "zsh" => {
            if has(&["-c", "-s", "--no-rcs", "-f"]) {
                return plain;
            }
            let Some(dir) = dir else { return plain };
            // zsh reads its dot files from $ZDOTDIR: otterm's copies source the user's, then the
            // hook (docs/03 §6.2).
            let user = std::env::var_os("ZDOTDIR")
                .filter(|v| !v.is_empty())
                .or_else(|| std::env::var_os("HOME"))
                .map(|v| v.to_string_lossy().into_owned())
                .unwrap_or_default();
            env.push(("ZDOTDIR".to_owned(), shell_path(&dir.join("zsh"))));
            env.push(("OTTERM_USER_ZDOTDIR".to_owned(), user));
            env.push(("OTTERM_ZSH_HOOK".to_owned(), shell_path(&dir.join("otterm.zsh"))));
            Integration { args, env }
        }
        "fish" => {
            if has(&["-c", "--command", "-C", "--init-command", "-N", "--no-config", "--private", "-P"]) {
                return plain;
            }
            let Some(dir) = dir else { return plain };
            // Runs after config.fish (which --no-config skips).
            let path = shell_path(&dir.join("otterm.fish")).replace('\\', "\\\\").replace('\'', "\\'");
            let mut args = args;
            if !user_files {
                args.insert(0, "--no-config".to_owned());
            }
            args.extend(["--init-command".to_owned(), format!("source '{path}'")]);
            Integration { args, env }
        }
        _ => plain,
    }
}

/// The folder holding the hook scripts, written on first use; `None` when it cannot be written.
pub fn hooks_dir() -> Option<PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = otterm_config::config_dir()?.join("shell-integration");
        for (name, content) in HOOK_FILES {
            let path = dir.join(name);
            // Unchanged files are left alone: their modification time tells the user what is new.
            if std::fs::read_to_string(&path).is_ok_and(|s| s == *content) {
                continue;
            }
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok()?;
            }
            std::fs::write(&path, content).ok()?;
        }
        Some(dir)
    })
    .clone()
}

/// A path as the Unix shells on Windows (Git Bash, MSYS2) take it: forward slashes.
fn shell_path(path: &Path) -> String {
    let s = path.display().to_string();
    if cfg!(windows) { s.replace('\\', "/") } else { s }
}

/// PowerShell's -EncodedCommand form.
fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
