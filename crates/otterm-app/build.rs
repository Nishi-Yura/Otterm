use std::path::{Path, PathBuf};

fn main() {
    copy_conpty();
    tauri_build::build();
}

/// On Windows, put the bundled ConPTY (decision M3) next to the executable: portable-pty loads
/// `conpty.dll` from there, and `conpty.dll` starts the `OpenConsole.exe` beside it. Without the
/// files the app still runs, on the slower ConPTY that ships with Windows.
fn copy_conpty() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let resources = manifest.join("resources").join("windows");
    println!("cargo:rerun-if-changed={}", resources.join("VERSION").display());

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("aarch64") => "arm64",
        _ => return,
    };
    let src = resources.join(arch);
    if !src.join("conpty.dll").exists() {
        println!(
            "cargo:warning=bundled ConPTY missing; run `node scripts/fetch-conpty.js` (falls back to the system ConPTY)"
        );
        return;
    }
    // OUT_DIR is <target>/<profile>/build/<pkg>-<hash>/out; the executable goes to <target>/<profile>.
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let Some(exe_dir) = out.ancestors().nth(3) else { return };
    for file in ["conpty.dll", "OpenConsole.exe"] {
        copy_if_changed(&src.join(file), &exe_dir.join(file));
    }
}

fn copy_if_changed(from: &Path, to: &Path) {
    let same = std::fs::metadata(from).ok().map(|m| m.len()) == std::fs::metadata(to).ok().map(|m| m.len());
    if !same && let Err(e) = std::fs::copy(from, to) {
        println!("cargo:warning=could not copy {} to {}: {e}", from.display(), to.display());
    }
}
