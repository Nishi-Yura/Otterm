//! Shell integration loaded through the shell's start arguments (decision B6: no user file is
//! changed). PowerShell only for now, and only the working directory (OSC 7); the rest is M2.

use std::path::PathBuf;

const PWSH_SCRIPT: &str = include_str!("shell/otterm.ps1");

/// Arguments that start `program` with otterm's integration, or none when there is none for it.
pub fn integration_args(program: &str) -> Vec<String> {
    let stem =
        std::path::Path::new(program).file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if stem != "pwsh" && stem != "powershell" {
        return Vec::new();
    }
    let Some(script) = script_file() else { return Vec::new() };
    // -NoExit keeps the shell open after the command; the profile still loads first, so the
    // script wraps the prompt the profile set up. Single quotes double inside a quoted path.
    let path = script.display().to_string().replace('\'', "''");
    vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into(), format!(". '{path}'")]
}

/// Write the script where the shell can read it; rewritten when otterm's copy differs.
fn script_file() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join("otterm").join("shell");
    let path = dir.join("otterm.ps1");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(PWSH_SCRIPT) {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, PWSH_SCRIPT).ok()?;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_powershell_gets_arguments() {
        assert!(integration_args("/bin/zsh").is_empty());
        let args = integration_args("pwsh.exe");
        assert_eq!(&args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert!(args[3].starts_with(". '") && args[3].ends_with("otterm.ps1'"));
        assert_eq!(integration_args("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe").len(), 4);
    }
}
