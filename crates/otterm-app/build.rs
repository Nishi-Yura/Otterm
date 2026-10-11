use std::path::{Path, PathBuf};

fn main() {
    copy_conpty();
    embed_bundled_mods();
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

/// Folders of a mod that ship with the app (docs/05 §3); sources and tooling stay behind.
const MOD_DIRS: &[&str] = &["dist", "locales", "dictionary", "assets", "rules", "workflows"];
const MOD_FILES: &[&str] = &["otmod.toml", "README.md", "theme.toml", "layout.toml", "workflows.toml", "icon.png"];

/// The bundled mods (`mods/*` of the repository, decision L6) are compiled into the executable
/// as `bundled_mods.rs`: a list of (path, bytes) and a hash of the whole, which the app uses to
/// write them out to its data folder on first start or when they changed (docs/05 §9).
/// An extension whose `dist/main.js` is missing is left out with a warning: run
/// `pnpm --filter "./mods/*" build` first.
fn embed_bundled_mods() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let mods = manifest.join("..").join("..").join("mods");
    println!("cargo:rerun-if-changed={}", mods.display());
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    if let Ok(entries) = std::fs::read_dir(&mods) {
        let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let name = dir.file_name().unwrap().to_string_lossy().into_owned();
            if !dir.join("otmod.toml").exists() {
                continue;
            }
            let text = std::fs::read_to_string(dir.join("otmod.toml")).unwrap_or_default();
            // The folder written out is named after the id (`otterm.cmd-explain`), as installed
            // mods are; the repository folder drops the `otterm.` prefix.
            let name = text
                .lines()
                .find_map(|l| {
                    l.trim().strip_prefix("id")?.trim().strip_prefix('=')?.trim().strip_prefix('"')?.split('"').next()
                })
                .map(str::to_owned)
                .unwrap_or(name);
            let is_extension = text.contains("kind = \"extension\"");
            if is_extension && !dir.join("dist").join("main.js").exists() {
                println!(
                    "cargo:warning=bundled mod {name} has no dist/main.js; run `pnpm --filter \"./mods/*\" build`"
                );
                continue;
            }
            for f in MOD_FILES {
                let p = dir.join(f);
                if p.is_file() {
                    files.push((format!("{name}/{f}"), p));
                }
            }
            for d in MOD_DIRS {
                collect(&dir.join(d), &format!("{name}/{d}"), &mut files);
            }
        }
    }
    let mut code = String::new();
    code.push_str("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (rel, path) in &files {
        println!("cargo:rerun-if-changed={}", path.display());
        if let Ok(bytes) = std::fs::read(path) {
            for b in rel.as_bytes().iter().chain(bytes.iter()) {
                hash = (hash ^ *b as u64).wrapping_mul(0x0100_0000_01b3);
            }
        }
        code.push_str(&format!("    ({:?}, include_bytes!({:?})),\n", rel, path.to_string_lossy().replace('\\', "/")));
    }
    code.push_str("];\n");
    code.push_str(&format!("pub static HASH: &str = \"{hash:016x}\";\n"));
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("bundled_mods.rs");
    std::fs::write(out, code).expect("write bundled_mods.rs");
}

fn collect(dir: &Path, rel: &str, files: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut list: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    list.sort();
    for p in list {
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        if p.is_dir() {
            collect(&p, &format!("{rel}/{name}"), files);
        } else if p.is_file() {
            files.push((format!("{rel}/{name}"), p));
        }
    }
}
