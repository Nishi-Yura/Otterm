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
        let git_bash = std::env::var_os("ProgramFiles")
            .map(|d| PathBuf::from(d).join("Git").join("bin").join("bash.exe"))
            .filter(|p| p.is_file());
        if let Some(p) = git_bash {
            out.push(make("git-bash", "Git Bash", p, &["--login", "-i"]));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_distributions_come_from_reg_output() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{a}\r\n    DistributionName    REG_SZ    Ubuntu-22.04\r\n\r\nHKEY_CURRENT_USER\\...\\{b}\r\n    DistributionName    REG_SZ    docker-desktop\r\n    DistributionName    REG_SZ    My Arch\r\n\r\n2 match(es) found.\r\n";
        assert_eq!(parse_distros(out), ["Ubuntu-22.04", "My Arch"]);
        assert!(parse_distros("ERROR: The system was unable to find the specified registry key or value.").is_empty());
    }

    #[test]
    fn configured_profiles_come_first_and_win_over_detected_ones() {
        let mut c = Config::default();
        c.profiles.push(Profile {
            id: "cmd".into(),
            name: "My cmd".into(),
            command: "cmd.exe".into(),
            ..Profile::default()
        });
        c.profiles.push(Profile { id: "gone".into(), hidden: true, ..Profile::default() });
        // Hiding a profile with a detected shell's id hides that shell too.
        c.profiles.push(Profile { id: "pwsh".into(), hidden: true, ..Profile::default() });
        let list = all(&c);
        assert_eq!(list[0].name, "My cmd");
        assert_eq!(list.iter().filter(|p| p.id == "cmd").count(), 1);
        assert!(list.iter().all(|p| p.id != "gone"), "hidden profiles stay out of the menu");
        assert!(list.iter().all(|p| p.id != "pwsh"), "a hidden id hides the detected shell");
    }
}
