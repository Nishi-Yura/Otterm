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
    for p in detected() {
        if !list.iter().any(|q| q.id == p.id) {
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
    } else {
        for (id, name, path) in [("zsh", "zsh", "/bin/zsh"), ("bash", "bash", "/bin/bash"), ("fish", "fish", "")] {
            let found = if path.is_empty() { in_path(id) } else { Some(PathBuf::from(path)).filter(|p| p.is_file()) };
            if let Some(p) = found {
                let login: &[&str] = if cfg!(target_os = "macos") { &["-l"] } else { &[] };
                out.push(make(id, name, p, login));
            }
        }
    }
    out
}

fn in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| Path::new(p).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let list = all(&c);
        assert_eq!(list[0].name, "My cmd");
        assert_eq!(list.iter().filter(|p| p.id == "cmd").count(), 1);
        assert!(list.iter().all(|p| p.id != "gone"), "hidden profiles stay out of the menu");
    }
}
