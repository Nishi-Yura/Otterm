//! Shell profiles for the new-tab menu (docs/03 §3.2): the ones in config.toml, then shells found
//! on this computer that the config does not already name.

use std::path::{Path, PathBuf};

use otterm_config::{Config, Profile};
use serde::Serialize;

/// What the new-tab menu shows.
#[derive(Clone, Serialize)]
pub struct MenuEntry {
    pub id: String,
    pub name: String,
    /// Found on this computer rather than written in config.toml: the UI shows a translated name.
    pub detected: bool,
}

/// Configured profiles (not hidden), then detected ones, without duplicate ids.
pub fn all(config: &Config) -> Vec<Profile> {
    let mut list: Vec<Profile> = config.profiles.iter().filter(|p| !p.hidden).cloned().collect();
    // A configured profile, hidden or not, takes the place of a detected one with its id.
    for p in detected() {
        if !config.profiles.iter().any(|q| q.id == p.id) {
            list.push(p);
        }
    }
    list
}

pub fn find(config: &Config, id: &str) -> Option<Profile> {
    all(config).into_iter().find(|p| p.id == id)
}

/// Shells installed here.
fn detected() -> Vec<Profile> {
    let make = |id: &str, name: &str, command: PathBuf, args: &[&str]| Profile {
        id: id.into(),
        name: name.into(),
        command: command.display().to_string(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        ..Profile::default()
    };
    let mut out = Vec::new();
    if cfg!(windows) {
        if let Some(p) = in_path("pwsh.exe") {
            out.push(make("pwsh", "PowerShell 7", p, &[]));
        }
        if let Some(p) = in_path("powershell.exe") {
            out.push(make("powershell", "Windows PowerShell", p, &[]));
        }
        if let Some(p) = in_path("cmd.exe") {
            out.push(make("cmd", "Command Prompt", p, &[]));
        }
        // Git for Windows: the system installer, the per-user installer, scoop.
        let git_bash = [
            std::env::var_os("ProgramFiles").map(|d| PathBuf::from(d).join("Git")),
            std::env::var_os("ProgramFiles(x86)").map(|d| PathBuf::from(d).join("Git")),
            std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs").join("Git")),
            std::env::var_os("USERPROFILE")
                .map(|d| PathBuf::from(d).join("scoop").join("apps").join("git").join("current")),
        ]
        .into_iter()
        .flatten()
        .map(|d| d.join("bin").join("bash.exe"))
        .find(|p| p.is_file());
        if let Some(p) = git_bash {
            out.push(make("git-bash", "Git Bash", p, &["--login", "-i"]));
        }
        // MSYS2 at its default place. MSYSTEM picks the environment (UCRT64 is the one its
        // installer recommends); CHERE_INVOKING keeps the folder the tab was opened in.
        let msys2 = ["C:\\msys64", "C:\\msys32"]
            .iter()
            .map(|d| PathBuf::from(d).join("usr").join("bin").join("bash.exe"))
            .find(|p| p.is_file());
        if let Some(p) = msys2 {
            let mut profile = make("msys2", "MSYS2 (UCRT64)", p, &["--login", "-i"]);
            profile.env.insert("MSYSTEM".into(), "UCRT64".into());
            profile.env.insert("CHERE_INVOKING".into(), "1".into());
            out.push(profile);
        }
        if let Some(p) = in_path("nu.exe") {
            out.push(make("nu", "Nushell", p, &[]));
        }
        if let Some(wsl) = in_path("wsl.exe") {
            for name in wsl_distros() {
                let id =
                    format!("wsl-{}", name.to_ascii_lowercase().replace(|c: char| !c.is_ascii_alphanumeric(), "-"));
                out.push(make(&id, &format!("{name} (WSL)"), wsl.clone(), &["-d", name, "--cd", "~"]));
            }
        }
    } else {
        for (id, name, path) in [("zsh", "zsh", "/bin/zsh"), ("bash", "bash", "/bin/bash"), ("fish", "fish", "")] {
            let found = if path.is_empty() { in_path(id) } else { Some(PathBuf::from(path)).filter(|p| p.is_file()) };
            if let Some(p) = found {
                let login: &[&str] = if cfg!(target_os = "macos") { &["-l"] } else { &[] };
                out.push(make(id, name, p, login));
            }
        }
        if let Some(p) = in_path("nu") {
            out.push(make("nu", "Nushell", p, &[]));
        }
        if let Some(p) = in_path("pwsh") {
            out.push(make("pwsh", "PowerShell 7", p, &[]));
        }
    }
    out
}

/// WSL distributions, read once from the registry with reg.exe (starting WSL itself to list them
/// would boot its virtual machine).
#[cfg(windows)]
fn wsl_distros() -> &'static [String] {
    use std::os::windows::process::CommandExt;
    static LIST: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    LIST.get_or_init(|| {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss";
        std::process::Command::new("reg.exe")
            .args(["query", key, "/s", "/v", "DistributionName"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|out| parse_distros(&String::from_utf8_lossy(&out.stdout)))
            .unwrap_or_default()
    })
}

#[cfg(not(windows))]
fn wsl_distros() -> &'static [String] {
    &[]
}

/// Distribution names from `reg query ... /v DistributionName` output, without Docker Desktop's
/// internal ones.
fn parse_distros(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| line.trim().strip_prefix("DistributionName")?.trim().strip_prefix("REG_SZ"))
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty() && !name.starts_with("docker-desktop"))
        .collect()
}

fn in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| Path::new(p).is_file())
}
