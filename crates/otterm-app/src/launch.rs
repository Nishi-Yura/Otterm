//! Command-line arguments (docs/06 §4): `otterm [path]`, `otterm -e <command...>`,
//! `otterm --profile <id>`, `otterm --config <file>`, `otterm --safe-mode`, `otterm --new-window`,
//! `otterm --help`, `otterm --version`. Subcommands (`otterm mod …`, `otterm config …`) are in
//! `main.rs`'s `cli`.

use std::path::PathBuf;

/// `otterm --help`. The subcommands' own usage lines are printed by their `cli` functions.
pub const USAGE: &str = "\
usage: otterm [path] [--profile <id>] [-e <command...>] [--new-window] [--safe-mode] [--config <file>]
       otterm mod | theme | config | workflow | trash | ask ...
       otterm --help | --version

  path                 open the first tab in this folder (a file opens its folder)
  -e, --command ...    run this command in the first tab instead of the shell (takes the rest)
  -p, --profile <id>   start this profile ([[profiles]] id, or a detected one such as pwsh, cmd, wsl-ubuntu)
  --new-window         a window of its own instead of a tab in the running otterm
  --safe-mode          the default theme, no theme or user CSS, no mods
  --config <file>      a configuration file instead of the usual one
  -h, --help           this text
  -V, --version        the version

  otterm mod list|search|install|remove|enable|disable|update|publish|doctor|link
  otterm theme import <file>...
  otterm config path|get|set|reset|export|import
  otterm workflow run <name>
  otterm trash <path>...
  otterm ask [question]
";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Launch {
    /// `--help` / `-h`: print the usage and exit.
    pub help: bool,
    /// `--version` / `-V`: print the version and exit.
    pub version: bool,
    /// Folder for the first tab.
    pub cwd: Option<PathBuf>,
    /// Program and arguments the first tab runs instead of the shell.
    pub command: Option<Vec<String>>,
    /// Profile id the first tab starts.
    pub profile: Option<String>,
    /// Start a window of its own instead of a tab in the running otterm.
    pub new_window: bool,
    /// Configuration file to use instead of the usual one.
    pub config: Option<PathBuf>,
    /// `--safe-mode` (docs/04 §2.3): the default theme, no theme or user CSS, no mods.
    pub safe_mode: bool,
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
            "--help" | "-h" | "help" => launch.help = true,
            "--version" | "-V" => launch.version = true,
            "--config" => launch.config = args.next().map(PathBuf::from),
            "--safe-mode" => launch.safe_mode = true,
            "--profile" | "-p" => launch.profile = args.next().filter(|p| !p.is_empty()),
            "--new-window" => launch.new_window = true,
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
