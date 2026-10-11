//! Pseudo-terminal spawning for otterm. ConPTY on Windows, openpty elsewhere.
//! Spec: docs/02-architecture.md §4.1 (`otterm-pty`).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, native_pty_system};

/// Terminal size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl Default for PtySize {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

impl From<PtySize> for portable_pty::PtySize {
    fn from(s: PtySize) -> Self {
        Self { rows: s.rows, cols: s.cols, pixel_width: 0, pixel_height: 0 }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    /// Program to run. `None` = the platform default shell ([`default_shell`]).
    pub program: Option<String>,
    pub args: Vec<String>,
    /// Starting directory. `None` = the user's home directory.
    pub cwd: Option<PathBuf>,
    /// Extra environment variables, applied after otterm's own.
    pub env: Vec<(String, String)>,
    pub size: PtySize,
    /// Exposed to the shell as `OTTERM_SESSION_ID`.
    pub session_id: String,
}

/// The writable, resizable side of a running PTY.
pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

/// Everything [`Pty::spawn`] hands back. The reader and the child are meant to move to their own threads.
pub struct Spawned {
    pub pty: Pty,
    /// Raw output from the child. Reads block; EOF or an error means the PTY is gone.
    pub reader: Box<dyn Read + Send>,
    pub child: ChildProcess,
}

/// The spawned process, kept separate from [`Pty`] so that waiting does not block writes.
pub struct ChildProcess(Box<dyn Child + Send + Sync>);

impl ChildProcess {
    /// Block until the process exits and return its exit code.
    pub fn wait(mut self) -> Result<u32> {
        Ok(self.0.wait()?.exit_code())
    }

    pub fn pid(&self) -> Option<u32> {
        self.0.process_id()
    }
}

impl Pty {
    pub fn spawn(opts: SpawnOptions) -> Result<Spawned> {
        #[cfg(windows)]
        let_children_handle_ctrl_c();
        let pair = native_pty_system().openpty(opts.size.into()).context("open pty")?;

        let program = opts.program.clone().unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(&program);
        if opts.program.is_none() && opts.args.is_empty() && cfg!(target_os = "macos") {
            // Terminal.app and iTerm2 start login shells; profile files rely on it.
            cmd.arg("-l");
        }
        cmd.args(&opts.args);
        if let Some(cwd) = opts.cwd.clone().or_else(home_dir) {
            cmd.cwd(cwd);
        }
        for (k, v) in otterm_env(&opts.session_id) {
            cmd.env(k, v);
        }
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd).with_context(|| format!("spawn {program}"))?;
        // The child owns the slave now; keeping our copy open would hide EOF on Unix.
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().context("clone pty reader")?;
        let writer = pair.master.take_writer().context("take pty writer")?;
        let killer = child.clone_killer();

        Ok(Spawned { pty: Pty { master: pair.master, writer, killer }, reader, child: ChildProcess(child) })
    }

    /// Send input bytes (keystrokes, paste) to the child.
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, size: PtySize) -> Result<()> {
        self.master.resize(size.into())
    }

    pub fn kill(&mut self) -> Result<()> {
        let res = self.killer.kill();
        // portable-pty 0.9.0 inverts the TerminateProcess check on Windows: it returns Err when the
        // kill succeeded (and Ok when it failed). Until that is fixed upstream, the result says nothing.
        if cfg!(windows) {
            return Ok(());
        }
        Ok(res?)
    }
}

/// Variables otterm always sets for its children (docs/02 §4.1).
fn otterm_env(session_id: &str) -> Vec<(&'static str, String)> {
    vec![
        ("TERM", "xterm-256color".into()),
        ("COLORTERM", "truecolor".into()),
        ("TERM_PROGRAM", "otterm".into()),
        ("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION").into()),
        ("OTTERM", "1".into()),
        ("OTTERM_SESSION_ID", session_id.into()),
    ]
}

/// Windows passes "ignore Ctrl+C" from a process to the processes it starts. otterm started from
/// a program that ignores Ctrl+C (some launchers, MSYS shells) would hand that to every shell, and
/// Ctrl+C would stop nothing. Clear it for ourselves before the first child is created.
#[cfg(windows)]
#[allow(unsafe_code)]
fn let_children_handle_ctrl_c() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: with no handler routine, SetConsoleCtrlHandler only sets this process's
        // "ignore Ctrl+C" attribute (here: off). It touches no memory of ours.
        unsafe {
            windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
        }
    });
}

/// The shell used when no profile is configured.
/// Windows: PowerShell 7 if installed, else Windows PowerShell (docs/03 §1). Unix: `$SHELL`, else `/bin/sh`.
pub fn default_shell() -> String {
    if cfg!(windows) {
        if find_in_path("pwsh.exe").is_some() { "pwsh.exe".into() } else { "powershell.exe".into() }
    } else {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into())
    }
}

fn find_in_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(exe)).find(|p| Path::new(p).is_file())
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from)
}
