//! Command-line arguments (docs/06 §4): `otterm [path]`, `otterm -e <command...>`,
//! `otterm --config <file>`. The other commands there (mods, themes, workflows) come later.

use std::path::PathBuf;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Launch {
    /// Folder for the first tab.
    pub cwd: Option<PathBuf>,
    /// Program and arguments the first tab runs instead of the shell.
    pub command: Option<Vec<String>>,
    /// Configuration file to use instead of the usual one.
    pub config: Option<PathBuf>,
    /// Arguments that were not understood, to report.
    pub unknown: Vec<String>,
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Launch {
    let mut launch = Launch::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            // Everything after -e is the command, flags included.
            "-e" | "--command" => {
                let command: Vec<String> = args.by_ref().collect();
                if !command.is_empty() {
                    launch.command = Some(command);
                }
            }
            "--config" => launch.config = args.next().map(PathBuf::from),
            a if a.starts_with('-') => launch.unknown.push(arg),
            _ => {
                let path = PathBuf::from(&arg);
                // A file opens its folder (e.g. "Open with otterm" on a file).
                let dir = if path.is_file() { path.parent().map(PathBuf::from) } else { Some(path) };
                match dir.filter(|d| d.is_dir()) {
                    // Absolute without resolving links: canonicalize gives \\?\C:\... on
                    // Windows, which cmd.exe cannot start in.
                    Some(d) => launch.cwd = Some(std::path::absolute(&d).unwrap_or(d)),
                    None => launch.unknown.push(arg),
                }
            }
        }
    }
    launch
}
