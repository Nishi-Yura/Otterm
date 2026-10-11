//! `otterm.com`, the console face of otterm on Windows (docs/06 §4).
//!
//! Release builds of `otterm.exe` are GUI programs: started from cmd or PowerShell they get no
//! console to print to, and the shell does not wait for them, so `otterm config get` would print
//! nothing. This small console program sits next to it as `otterm.com`; `.COM` comes before
//! `.EXE` in `PATHEXT`, so typing `otterm` runs it. A subcommand runs `otterm.exe` and copies what
//! it prints to this console, then exits with its exit code; anything else starts the window and
//! returns at once, as `otterm.exe` would.
//!
//! The output goes through pipes: a GUI process is attached to no console, so handing it the
//! console's own handles is not enough (its writes go nowhere). Pipes need no `unsafe` and no
//! Windows API.

use std::io::Write;
use std::process::{Command, ExitCode, Stdio};

/// First arguments that print and exit instead of opening a window (`cli` in otterm-app).
const SUBCOMMANDS: &[&str] = &["mod", "theme", "config", "workflow", "trash", "ask"];

fn main() -> ExitCode {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let Ok(me) = std::env::current_exe() else { return fail("cannot find otterm.com itself") };
    let gui = me.with_file_name(if cfg!(windows) { "otterm.exe" } else { "otterm" });
    // Renamed to otterm.exe by mistake, it would start itself forever.
    if gui == me || !gui.is_file() {
        return fail(&format!("otterm.exe is not next to {}", me.display()));
    }
    let mut command = Command::new(&gui);
    command.args(&args);
    let subcommand = args.first().and_then(|a| a.to_str()).is_some_and(|a| SUBCOMMANDS.contains(&a));
    if subcommand {
        let mut child = match command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
            Ok(c) => c,
            Err(e) => return fail(&format!("{}: {e}", gui.display())),
        };
        let mut err = child.stderr.take().expect("piped");
        let errors = std::thread::spawn(move || std::io::copy(&mut err, &mut std::io::stderr()));
        if let Some(mut out) = child.stdout.take() {
            let _ = std::io::copy(&mut out, &mut std::io::stdout());
        }
        let _ = errors.join();
        let _ = std::io::stdout().flush();
        return match child.wait() {
            Ok(status) => ExitCode::from(status.code().map_or(1, |c| u8::try_from(c).unwrap_or(1))),
            Err(e) => fail(&format!("{}: {e}", gui.display())),
        };
    }
    // The window outlives this console; leave it nothing to write to.
    match command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => fail(&format!("{}: {e}", gui.display())),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("otterm: {message}");
    ExitCode::from(2)
}
